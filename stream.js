'use strict';
(function() {

var twitterAPI = require('node-twitter-api'),
    fs = require('fs'),
    https = require('https'),
    http = require('http'),
    _ = require('lodash'),
    actions = require('./actions'),
    updateUsers = require('./update-users'),
    util = require('./util'),
    setup = require('./setup'),
    prom = require('prom-client'),
    verifyCredentials = require('./verify-credentials');

var twitter = setup.twitter,
    logger = setup.logger,
    sequelize = setup.sequelize,
    remoteUpdatemutes = setup.remoteUpdatemutes,
    Action = setup.Action,
    BtUser = setup.BtUser;

var stats = {
  events: new prom.Counter('events', 'Number of events received from streaming API', ['type']),
  mutes: new prom.Counter('mutes', 'Number of mutes applied based on the streaming API', ['type']),
  streams: new prom.Gauge('streams', 'Number of active streams.'),
}

var workerId = 1;
var numWorkers = 1;

// An associative array of streams currently running. Indexed by uid.
var streams = {};

/**
 * Keep an in-memory map of the BtUsers table to be able to easily figure out
 * which dead streams need to be restarted.
 * @type {Object.<string>} A map from uids to user objects.
 */
var allUsers = {};
var allUsersLastUpdate = 0;

/**
 * Do the initial stream startup for all users belonging to this worker.
 * Stream startup is spaced out every 100ms, and streams that fail will
 * not be retried until every stream has had a chance at being started.
 * Once all streams have started, move to a refresh mode that both restarts any
 * failed streams and updates any new users from the DB.
 */
function startStreams() {
  var uids = Object.keys(allUsers);
  // Start a stream for each user, spaced 150 ms apart. Once all users have had
  // their stream started, start the periodic process of checking for any
  // streams that have failed and restarting them.
  util.slowForEach(uids, 150, function(uid) {
    startStream(allUsers[uid]);
  }).then(function() {
    logger.info('Done with initial stream starts, moving to refresh mode.');
    setInterval(refreshUsers, 20000);
    setInterval(refreshStreams, 10000);
  }).catch(function(err) {
    logger.error(err);
  });
}

/**
 * When a stream ends, it is removed from the global streams map. Generally we
 * will want to restart the stream. This function finds users that are in
 * allUsers, but not in streams, checks whether they should still be in
 * allUsers, and if so restarts their stream.
 */
function refreshStreams() {
  var streamingIds = Object.keys(streams);
  logger.info('Active streams:', streamingIds.length);
  stats.streams.set(streamingIds.length);
  // Find all users who don't already have a running stream.
  var missingUserIds = _.difference(Object.keys(allUsers), streamingIds);
  if (missingUserIds.length) {
    var sample = missingUserIds.slice(0, 15);
    logger.info('Restarting streams for', missingUserIds.length,
      'users that had no active stream:', sample.join(", "));
  }
  // Handle at most 20 users at once, to avoid flooding. Choose a random 20, so
  // if the first 20 have some unexpected issue we don't get stuck on them.
  _.sample(missingUserIds, 20).forEach(function(userId) {
    logger.info('Restarting stream for', userId);
    BtUser.findById(userId)
      .then(function(user) {
        if (user && !user.deactivatedAt) {
          allUsers[userId] = user;
          // Under heavy load, multiple calls to refreshStreams can get stacked
          // up, meaning that by the time we get the success callback from
          // MySQL, a previous call has already started a given stream. So we
          // check a second time that the stream isn't already running.
          if (!streams[userId]) {
            startStream(user);
          } else {
            logger.info('Nope, not restarting stream for', userId, 'because already in streamingIds');
          }
        } else {
          logger.info('User', user, 'missing or deactivated.');
          delete allUsers[userId];
        }
      }).catch(function(err) {
        logger.error(err);
      });
  });
}

/**
 * Update the global allUsers map with any recently-updated users that belong to
 * this worker. Uses a simple modulus to decide which users belong to which
 * workers. Checkpoint the last update time so we can query for only the
 * updated users.
 */
function refreshUsers() {
  var now = new Date();
  return BtUser
    .findAll({
      where: sequelize.and({
        deactivatedAt: null,
        updatedAt: {
          gt: allUsersLastUpdate
        },
      },
      ['uid % ? = ?', numWorkers, workerId % numWorkers],
      // Check for any option that monitors stream for automute criteria
      sequelize.or(
        { mute_new_accounts: true },
        { mute_low_followers: true },
        { shared_mutes_key: { not: null } }
      ))
    }).then(function(users) {
      _.extend(allUsers, _.indexBy(users, 'uid'));
      allUsersLastUpdate = now;
    }).error(function(err) {
      logger.error(err);
    });
}

/**
 * When a stream fails, we want to wait a while before restarting. This function
 * replaces the stream with a placeholder, so it won't be restarted. After the
 * given amount of time, if that placeholder is still in place, delete the
 * stream so it will be restarted.
 */
function restartStreamAfter(seconds, uid) {
  var randomPlaceholder = Math.random();
  streams[uid] = randomPlaceholder;
  setTimeout(function() {
    if (streams[uid] === randomPlaceholder) {
      delete streams[uid];
    } else {
      logger.error('Tried to delete stream but it had already been replaced', uid);
    }
  }, seconds * 1000);
}

/**
 * For a given user, connect to the Twitter Streaming API, start receiving
 * updates, and record that connection in the streams map. Also retroactively
 * check the REST API for any mentions we might have missed during downtime.
 * @param {BtUser} User to receive streaming events for.
 */
function startStream(user) {
  var accessToken = user.access_token;
  var accessTokenSecret = user.access_token_secret;
  var boundDataCallback = dataCallback.bind(undefined, user);
  var boundEndCallback = endCallback.bind(undefined, user, new Date());

  logger.info('Starting stream for user', user);
  var req = twitter.getStream('user', {
    // Get events for all replies, not just people the user follows.
    'replies': 'all',
    // Only get user-related events, not all tweets in timeline.
    'with': 'user'
  }, accessToken, accessTokenSecret, boundDataCallback, boundEndCallback);

  // Sometimes we get an ECONNRESET that is not caught in the OAuth code
  // like it should be. Catch it here as a backup.
  req.on('error', function(err) {
    logger.error('Socket error for', user, err.message);
    // Per https://dev.twitter.com/streaming/overview/connecting,
    // backoff up to 16 seconds for TCP/IP level network errors.
    // We don't implement the backoff, we just go right to 16 seconds.
    restartStreamAfter(16, user.uid);
  });
  // In normal operation, each open stream should receive an empty data item
  // '{}' every 30 seconds for keepalive. Sometimes a connection will die
  // without Node noticing it for instance if the host switches networks.
  // This ensures the HTTPS request is aborted, which in turn calls
  // endCallback, removing the entry from streams and allowing it to be started
  // again.
  req.setTimeout(90000, function() {
    logger.error('Stream timeout for user', user, 'aborting.');
    req.abort();
  });

  streams[user.uid] = req;
  stats.streams.set(Object.keys(streams).length);

  // When restarting the service or experiencing downtime, there's a gap in
  // streaming coverage. Make sure we cover any tweets we may have missed.
  // NOTE: Temporarily disabled due to performance issues and repeated enqueues
  // of already-cancelled mutes.
  //checkPastMentions(user);
};

/**
 * Fetch a user's mentions from the Twitter REST API, in case we missed any
 * streaming events during downtime. All mentions will get processed the same
 * way as if they had been received through the streaming API. Note that the
 * '< 7 days' criterion will be based on the current time.
 * @param {BtUser} user User to fetch mentions for.
 */
function checkPastMentions(user) {
  twitter.getTimeline('mentions', {count: 50},
    user.access_token, user.access_token_secret,
    function(err, mentions) {
      if (err) {
        logger.error('Error', err.statusCode, '/statuses/mentions',
          err.data, 'for', user);
      } else {
        logger.debug('Replaying', mentions.length, 'past mentions for', user);
        // It's common to have a large number of mentions from each user,
        // because of back-and-forth conversations. De-dupe users before
        // checking for mute criteria.
        var mentioningUsers = _.indexBy(_.map(mentions, 'user'), 'id_str');
        Object.keys(mentioningUsers).forEach(function(id_str) {
          checkReplyAndmute(user, mentioningUsers[id_str]);
        });
      }
    });
}

/**
 * Called when a stream ends for any reason. Verify the user's credentials to
 * mark them as deactivated if necessary, and remove them from the active
 * streams map.
 * @param {BtUser} user The user whose stream ended.
 * @param {Date} streamStartTime The time the stream started
 * @param {http.IncomingMessage} httpIncomingMessage The HTTP message for the stream.
 */
function endCallback(user, streamStartTime, httpIncomingMessage) {
  var statusCode = httpIncomingMessage.statusCode;
  logger.warn('Ending stream with', statusCode, 'for', user,
    'after', Math.round((new Date() - streamStartTime) / 1000), 'seconds');
  if (statusCode === 401 || statusCode === 403) {
    verifyCredentials(user);
    // Per https://dev.twitter.com/streaming/overview/connecting,
    // backoff up to 320 seconds (5.3 min) for HTTP errors.
    // We don't implement the backoff, just go straight to 320.
    logger.info('Scheduling', user, 'for stream restart in 5.3 min');
    restartStreamAfter(320, user.uid);
  } else if (statusCode === 420) {
    // The streaming API will return 420 Enhance Your Calm
    // (http://httpstatusdogs.com/420-enhance-your-calm) if the user is connected
    // to the streaming API too many times. If we get that, wait fifteen minutes
    // before reconnecting. This is an attempt to fix a bug where, under heavy
    // load, stream.js would lose track of some connections and reconnect too
    // fast, leading to an unproductive high-CPU loop of trying to restart those
    // loops once a second.
    var stream = streams[user.uid];
    logger.info('Scheduling', user, 'for stream restart in 15 min');
    restartStreamAfter(15 * 60, user.uid);
  } else {
    logger.info('Scheduling', user, 'for stream restart in 5.3 min');
    restartStreamAfter(5.3 * 60, user.uid);
  }
}

/**
 * Called each time there is data available on the user stream.
 * Given the arguments passed to getStream, the only events we receive should be
 * at-replies. TODO: Add sanity check to filter non-at-replies, just in case.
 *
 * On receiving an at-reply, check the age of the sender. If it is less than
 * seven days, mute them. Exception: Do not mute someone our user already follows.
 */
function dataCallback(recipientBtUser, err, data, ret, res) {
  var recipientUid = recipientBtUser.uid;
  streams[recipientUid].lastData = +new Date();
  if (!data) return;
  if (data.disconnect) {
    stats.events.labels("disconnect").inc()
    logger.warn(recipientBtUser, 'disconnect message:', data.disconnect);
    // Code 6 is for revoked, e.g.:
    // { code: 6, stream_name:
    //   'twestact4&XXXXXXXXXXXXXXXXXXXXXXXXX-userstream685868461329014147',
    //    reason: 'token revoked for userId 596947990' }
    // Codes 13 and 14 are for user deleted and suspended, respectively.
    if (data.disconnect.code === 6 ||
        data.disconnect.code === 13 ||
        data.disconnect.code === 14) {
      verifyCredentials(recipientBtUser);
    }
  } else if (data.warning) {
    if (data.warning.code === 'FOLLOWS_OVER_LIMIT') {
      // These happen any time you start a stream for a user with more than 10k
      // follows, so they are normal and we don't care. They mean that you won't
      // see all tweets on the user's timeline, but we don't care about timeline
      // tweets anyhow.
    } else {
      stats.events.labels("warning").inc()
      logger.warn('Stream warning for', recipientBtUser, data.warning.code,
        data.warning.message);
    }
  } else if (data.event) {
    stats.events.labels(data.event).inc()
    logger.debug('User', recipientBtUser, 'event', data.event);
    if (data.event === 'unmute' || data.event === 'mute') {
      logger.info('User', recipientBtUser, data.event,
        data.target.screen_name, data.target.id_str);
      handlemuteEvent(recipientBtUser, data);
    } else if (data.event === 'user_update') {
      verifyCredentials(recipientBtUser);
    } else if (data.event === 'quoted_tweet') {
      checkReplyAndmute(recipientBtUser, data.source);
    }
  } else if (data.text && !data.retweeted_status && data.user) {
    stats.events.labels("text").inc()
    // If user A tweets "@foo hi" and user B retweets it, that should not count
    // as a mention of @foo for the purposes of muteing. That retweet would
    // show up in the streaming API with text: "@foo hi", as if user B had
    // tweeted it. The way we would tell it was actually a retweet is because
    // it also has the retweeted_status field set.
    checkReplyAndmute(recipientBtUser, data.user);
  }
}

/**
 * Given a user object from either the streaming API or the REST API,
 * check whether a mention from that user should trigger a mute,
 * i.e. whether they are less than 7 days old or have fewer than 15
 * followers, and the receiving user has enabled the appropriate option.
 * If so, enqueue a mute.
 *
 * @param {BtUser} recipientBtUser User who might be doing the muteing.
 * @param {Object} mentioningUser A JSON User object as specified by the
 *   Twitter API: https://dev.twitter.com/overview/api/users
 */
var MIN_AGE = 7;
var MIN_FOLLOWERS = 15;
function checkReplyAndmute(recipientBtUser, mentioningUser) {
  // If present, data.user is the user who sent the at-reply.
  if (mentioningUser && mentioningUser.created_at &&
      mentioningUser.id_str !== recipientBtUser.uid) {
    var ageInDays = (new Date() - Date.parse(mentioningUser.created_at)) /
      86400 / 1000;
    logger.info('User', recipientBtUser, 'got at reply from',
      mentioningUser.screen_name, mentioningUser.id_str, '(age', ageInDays,
      '/ followers', mentioningUser.followers_count, ')');
    if (ageInDays < MIN_AGE || mentioningUser.followers_count < MIN_FOLLOWERS) {
      // The user may have changed settings since we started the stream. Reload to
      // get the latest setting.
      recipientBtUser.reload().then(function(user) {
        if (ageInDays < MIN_AGE && recipientBtUser.mute_new_accounts) {
          logger.info('Queuing mute', recipientBtUser, '-->',
            mentioningUser.screen_name, mentioningUser.id_str);
          enqueuemute(recipientBtUser, mentioningUser.id_str, Action.NEW_ACCOUNT);
        } else if (mentioningUser.followers_count < MIN_FOLLOWERS && recipientBtUser.mute_low_followers) {
          logger.info('Queuing mute', recipientBtUser, '-->',
            mentioningUser.screen_name, mentioningUser.id_str);
          enqueuemute(recipientBtUser, mentioningUser.id_str, Action.LOW_FOLLOWERS);
        }
      }).catch(function(err) {
        logger.error(err);
      });
    }
  }
}

/**
 * @type {Object.<string,number>} Currently running timers to check mutes. Used
 * by handlemuteEvent.
 */
var updatemutesTimers = {};

/**
 * Given a mute/unmute event from the streaming API, record it in Actions.
 * We will use unmutes so we know not to re-mute that user in the future.
 * NOTE: When we perform unmute
 * actions on a user, they get echoed back to us through the Streaming API.
 * Since the Action we performed in already in the DB, we don't want to insert a
 * different record with cause = 'external'. So we check the DB to avoid
 * recording duplicates.
 *
 * @param {BtUser} recipientBtUser User who received a mute / unmute event on their
 *   stream.
 * @param {Object} data A JSON unmute event from the Twitter streaming API.
 */
function handlemuteEvent(recipientBtUser, data) {
  // Users with very high mute counts don't get instant updates triggered by
  // the streaming API, because those updates are somewhat costly. Instead their
  // updates come from the periodic updatemutes refresh, or from loading their
  // my-mutes page.
  if (recipientBtUser.muteCount && recipientBtUser.muteCount > 50000) {
    return;
  }
  // When we perform an unmute action, it gets echoed back from the Stream API
  // very quickly - on the order of milliseconds. In order to make sure
  // actions.js has had a chance to write the 'done' status to the DB, we wait a
  // second before checking for duplicates.
  // Also, if several mutes or unmutes come rapidly, we keep postponing the
  // updatemutes call by a second each time. This prevents excessive resource
  // use when a user does a 'mute all' and many mutes show up in the streaming
  // API very rapidly.
  var timerId = updatemutesTimers[recipientBtUser.uid];
  if (timerId) {
    clearTimeout(timerId);
  }
  updatemutesTimers[recipientBtUser.uid] = setTimeout(function() {
    updateNonPendingmutes(recipientBtUser);
  }, 2000);
}

/**
 * Call remote update mutes, but only the the user has zero pending actions.
 * This reduces the amount of work update-mutes.js has to do for users who are
 * in the middle of executing large mute lists.
 * @param {BtUser} recipientBtUser
 */
function updateNonPendingmutes(recipientBtUser) {
  Action.count({
    where: {
      source_uid: recipientBtUser.uid,
      status: Action.PENDING
    },
    limit: 1
  }).then(function(count) {
    if (count === 0) {
      remoteUpdatemutes(recipientBtUser);
    }
  }).catch(function(err) {
    logger.error(err);
  });
}

/**
 * Put a mute on the Actions list for this user and process it.
 * @param {BtUser} sourceUser User who received a mention from a new account
 *   and will mute that new account.
 * @param {string} sinkUserId String-form UID of the author of the mention.
 *   Will be muteed.
 * @param {string} cause One of the valid cause types from Action object
 */
function enqueuemute(sourceUser, sinkUserId, cause) {
  stats.mutes.labels(cause).inc()
  actions.queueActions(
    sourceUser.uid, [sinkUserId], Action.mute, cause
  ).then(function() {
    actions.processActionsForUser(sourceUser);
  }).catch(function(err) {
    logger.error(err);
  });
}

if (require.main === module) {
  setup.statsServer(6600 + workerId);
  refreshUsers()
    .then(startStreams);
  var whoServer = http.createServer(function (req, res) {
    res.end(JSON.stringify({
      streams: _.mapValues(streams, (v) => new Date() - v.lastData),
      activeUsers: Object.keys(allUsers),
    }));
  });
  whoServer.listen(8800 + workerId);
}
})();
