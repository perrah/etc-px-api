'use strict';

var express = require('express');
var cors = require('cors');
var bodyParser = require('body-parser');
var https = require('https');
var url = require('url');
var WebSocketServer = require('ws').Server;
var WebSocket = require('ws');

var HttpsProxyAgent = require('https-proxy-agent');
var Promise = require('promise');
var util = require('util');

var uaaUrl = process.env.UAA_URL || '';
var wsUrl = process.env.TIMESERIES_INGEST_URL || '';
var wsQueryUrl = process.env.TIMESERIES_QUERY_URL || '';
var predixZoneId = process.env.PREDIX_ZONE_ID || '';
var timeseriesUrl = process.env.TIMESERIES_URL || '';
var appUrl = process.env.APP_URL || '';

var clients = {};
var timeseriesConnections = {};
var jsonParser = bodyParser.json();
var corporateProxyAgent;
var internals = {};

// Variables for Lab tests
var server = null;
var port = 4567;
var http = require('http');

var corporateProxyServer = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy;
if (corporateProxyServer) {
  console.log('Proxy detected: ' + corporateProxyServer);
  corporateProxyAgent = new HttpsProxyAgent(corporateProxyServer);
}

var app = express();
app.use(cors());

app.get('/', function(req, res) {
  res.status(200).send({"success": "You successfully hit the endpoint!"});
});

/**
 * Send HTTPS request to retrieve client token
 * @name requestToken
 *
 * @param {String} credentials
 * @param {String} id
 */
var requestToken = function requestToken(credentials, id) {
  return new Promise(function(resolve, reject) {
    var expireDate = new Date();
    var options = url.parse(uaaUrl + '/oauth/token');
    options.headers = {
      'Authorization': credentials,
      'Content-Type': 'application/x-www-form-urlencoded'
    };
    options.agent = corporateProxyAgent;
    options.method = 'POST';

    var request = https.request(options, function(res) {
      var body = '';
      res.on('data', function (chunk) {
        body += chunk;
      });
      res.on('end', function () {
        var jsonBody = JSON.parse(body);
        expireDate.setSeconds(expireDate.getSeconds() + jsonBody.expires_in);
        // Store client token in hash map
        clients[id] = {
          accessToken: jsonBody.access_token,
          expires: expireDate
        };

        resolve(clients[id]);
      }, function () {
        reject('Didn\'t work');
      });
    });

    request.write('grant_type=client_credentials&response_type=token');
    request.end();
  });
};

app.post('/dataPoints', jsonParser, function(req, res) {
  internals.body = req.body;
  console.log('REQ BODY' + JSON.stringify(req.body));
  getToken(req.headers['x-clientid'], req.headers['x-base64-credentials'])
  .then(getConnection)
  .then(sendData)
  .then(function(response){
    res.status(200).send({'success':"Data successfully ingested into Timeseries!"});
  }).catch(function(error){
    res.send(error);
  });
});

/**
* Query data from Time Series
* @name queryTimeSeries
*
* @param {Object} token
* @return {Object} Promise
*/
function queryTimeSeries(token) {
  return new Promise(function(resolve, reject){
    var bearerToken = 'Bearer ' + token.accessToken;
    var options = url.parse(wsQueryUrl);
    options.headers = {
      'Authorization': bearerToken,
      'Predix-Zone-Id': predixZoneId
    };
    options.agent = corporateProxyAgent;
    options.method = 'POST';

    var request = https.request(options, (res) => {
      var body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve(body);
      }, () => {
        reject('Didn\'t work');
      });
    });
    request.write(JSON.stringify(internals.queryBody));
    request.end();
  });
};

app.post('/queryDataPoints', jsonParser, function(req, res) {
  internals.queryBody = req.body;
  getToken(req.headers['x-clientid'], req.headers['x-base64-credentials'])
  .then(queryTimeSeries)
  .then(function(response){
    res.status(200).send(response);
  }).catch(function(error){
    res.send(error);
  });
});

/**
 * Request token or retrieve cached token
 * @name getToken
 *
 * @param {String} clientId
 * @param {String} base64Credentials
 * @return {Object} Promise
 */
function getToken(clientId, base64Credentials) {
  return new Promise(function(resolve, reject) {
    if (clients[clientId]) {
      var tokenExpires = new Date(clients[clientId].expires);
      var currentTime = new Date();
      if(currentTime.getTime() < tokenExpires.getTime()){
        console.log('CACHED TOKEN: ' + clients[clientId]);
        return resolve(clients[clientId]);
      }
    }
    requestToken(base64Credentials, clientId).then(function(response) {
      console.log('REQUEST TOKEN: ' + JSON.stringify(response));
      return resolve(response);
    }, function (error) {
      return reject(error);
    });
  });
};

/**
 * Connect to Timeseries service
 * @name getConnection
 *
 * @param {String} zoneId
 * @param {String} token
 */
function getConnection(token) {
  return new Promise(function(resolve, reject) {
    var bearerToken = 'Bearer ' + token.accessToken;
    console.log("BEARER TOKEN: " + bearerToken);
    var headers = {'Authorization': bearerToken, 'Predix-Zone-Id': predixZoneId, 'Origin':appUrl};
    console.log("PREDIX-ZONE-ID: " + predixZoneId);
    console.log("WS_URL: " + wsUrl);
    var socket = new WebSocket(wsUrl, {headers: headers});
        console.log("WEBSOCKET: " + socket);


    return resolve(socket);
  });
};

/**
 * Send data to Timeseries service
 * @name sendData
 *
 * @param {Object} connection
 * @param {Object} data
 */
function sendData(connection) {
  return new Promise(function(resolve, reject){

    connection.on('open', function open() {
      console.log("Web Socket connection opened...");
      connection.send(JSON.stringify(internals.body));
    });

    connection.on('close', function close(){
      console.log("Web Socket connection closed...");
    });

    connection.on('error', function(error){
      console.log("Socket Error: " + error);
    });

    connection.on('message', function(data){
      console.log("Message occurred...");
      if(data){
        console.log("MESSAGE: " + data);
        return resolve(data);
      } else{
        console.log("MESSAGE ERROR");
        return reject(data);
      }
    });

  });
};

module.exports = {

  start: function start(cb){
    server = http.createServer(app).listen(port, function(){
      console.log("Test App listening on port " + port);
    });
  },

  close: function close(cb){
    if(server) server.close(cb);
    console.log("Test app server closed...");
  }

};

app.listen(process.env.PORT || 3000, function () {
  console.log('App listening on port 3000');
});
