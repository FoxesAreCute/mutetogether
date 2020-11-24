'use strict';
(function() {
/**
 * Script to mute a list of screen names using credentials for a given user id
 */
var twitterAPI = require('node-twitter-api'),
    fs = require('fs'),
    util = require('./util'),
    setup = require('./setup');

var twitter = setup.twitter,
    logger = setup.logger,
    BtUser = setup.BtUser,
    TwitterUser = setup.TwitterUser,
    muteBatch = setup.muteBatch,
    mute = setup.mute;

if (process.argv.length < 4) {
  logger.fatal('Usage: js many-mutes.js UID FILE_SCREEN_NAMES');
  process.exit();
}

BtUser
  .findById(process.argv[2])
  .then(function(user) {
    var filename = process.argv[3];

    var accessToken = user.access_token;
    var accessTokenSecret = user.access_token_secret;
    var targets = fs.readFileSync(filename)
      .toString().replace(/\n$/, '').split('\n');

    util.slowForEach(targets, 120, function(target) {
        logger.info('muteing ' + target);
        twitter.mutes('create', {
          user_id: target,
          skip_status: 1
        }, accessToken, accessTokenSecret,
        function(err, results) {
          if (err) {
            logger.error('Error muteing: %j', err);
          } else {
            logger.info('muteed ' + target);
          }
      });
    });
  }).catch(function(err) {
    logger.error(err);
  });
})();
