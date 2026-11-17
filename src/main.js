import express from 'express';
import cookie from 'cookie';
import { WebSocketServer } from 'ws';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import colors from 'colors';
import dotenv from "dotenv";

import VispAuth from './authModules/visp.module.js';
import { safePathComponent, safeJoinedPath } from './pathSecurity.js';
import { findAssignedBundle, mediaBaseUrl } from './bundleAccess.js';
import { annotationVersion, annotationProblem, levelProblem, outsideLevelChange, isStrictBase64, isSsff, logSafe } from './saveValidation.js';

//the only media file type getBundle() hands out URLs for
const AUDIO_FILE_EXTENSION = "wav";

//the request types this server answers; anything else is refused without echoing it into the log
const REQUEST_TYPES = new Set(['GETPROTOCOL', 'GETDOUSERMANAGEMENT', 'LOGONUSER', 'GETGLOBALDBCONFIG', 'GETBUNDLELIST', 'GETBUNDLE', 'SAVEBUNDLE', 'WHOAMI']);

class AnnotationServer {
  constructor() {
    this.name = "VISP annotation server";
    this.version = "1.2.0";
    dotenv.config();
    colors.enable();
    this.logLevel = process.env.LOG_LEVEL ? process.env.LOG_LEVEL.toUpperCase() : "INFO";
    this.addLog("Log level is "+this.logLevel, "INFO");
    this.app = express();
    this.app.disable('x-powered-by');
    this.server = null;
    this.db = null;

    const expectedEnvVars = ["MONGO_DB_NAME", "MONGO_URI", "REPOSITORIES_PATH", "MEDIA_FILE_BASE_URL"];
    expectedEnvVars.forEach((envVar) => {
      if(typeof process.env[envVar] == "undefined") {
        this.addLog(envVar+" environment variable not set", "error");
        process.exit(1);
      }
    });

    //browsers send the Origin of the page opening a websocket, but do not enforce any policy on it - we have to,
    //or any site the user visits could talk to us with their cookies (cross-site websocket hijacking)
    this.allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",").map(origin => origin.trim()).filter(origin => origin)
      : [new URL(process.env.MEDIA_FILE_BASE_URL).origin];
    this.addLog("Allowed websocket origins: "+this.allowedOrigins.join(", "));

    this.authModule = new VispAuth(this);

    this.connectToMongo(process.env.MONGO_DB_NAME);
    this.setupEndpoints();
    this.startServer();
    this.setupWebSocket();
  }

  //cookie.parse only ever yields plain string values
  parseCookies(cookieHeader) {
    if(typeof cookieHeader !== 'string' || cookieHeader.length == 0) {
      return {};
    }
    return cookie.parse(cookieHeader);
  }

  emuDbPath(projectId) {
    return safeJoinedPath(process.env.REPOSITORIES_PATH, safePathComponent(projectId, "projectId"), "Data", "VISP_emuDB");
  }

  bundlePath(projectId, sessionName, bundleName) {
    return safeJoinedPath(
      this.emuDbPath(projectId),
      safePathComponent(sessionName, "session")+"_ses",
      safePathComponent(bundleName, "bundle")+"_bndl"
    );
  }

  readDbConfig(projectId) {
    return JSON.parse(fs.readFileSync(safeJoinedPath(this.emuDbPath(projectId), "VISP_DBconfig.json"), 'utf8'));
  }

  sendError(ws, callbackID, message) {
    ws.send(JSON.stringify({
      callbackID,
      status: {
        type: 'ERROR',
        message: message,
      },
    }));
  }

  setupEndpoints() {
    //These are the regular http endpoints, not the websockets part
    this.app.get('*', (req, res, next) => {
      this.addLog(req.method+" "+req.path);
      next();
    });
    this.app.get('/', (req, res) => {
      res.send('You have requested an empty endpoint.');
    });

    this.app.get('/file/project/:projectId/session/:sessionName/file/:fileName', async (req, res) => {
      const { projectId, sessionName, fileName } = req.params;
      try {
        let authResult = await this.authModule.authenticateUser(this.parseCookies(req.headers.cookie).PHPSESSID, projectId);

        if(authResult.authenticated == false) {
          this.addLog("User not authenticated while trying to access file "+fileName+" in session "+sessionName+" in project "+projectId+". Reason was: "+authResult.reason, "warn");
          res.status(401);
          res.send('You are not authenticated.');
          return;
        }

        //only the bundle audio files that getBundle() links to are served from here
        const extensionSuffix = "."+AUDIO_FILE_EXTENSION;
        if(!fileName.endsWith(extensionSuffix)) {
          res.status(404);
          res.send('File not found.');
          return;
        }
        const bundleName = fileName.slice(0, -extensionSuffix.length);
        if(!await this.assignedBundle(projectId, authResult.user.username, sessionName, bundleName)) {
          this.addLog("Refusing file "+fileName+" in session "+sessionName+" in project "+projectId+" to "+authResult.user.username+": bundle not assigned to them", "warn");
          res.status(404);
          res.send('File not found.');
          return;
        }
        const path = safeJoinedPath(this.bundlePath(projectId, sessionName, bundleName), bundleName+extensionSuffix);
        this.addLog("Requested file: "+path, "debug");

        if(!fs.existsSync(path)) {
          this.addLog("File not found: "+path, "warn");
          res.status(404);
          res.send('File not found.');
          return;
        }

        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(path, (error) => {
          if(error && !res.headersSent) {
            this.addLog("Error sending file "+path+": "+error.message, "error");
            res.status(500).end();
          }
        });
      }
      catch(error) {
        this.addLog("Error serving file "+fileName+" in session "+sessionName+" in project "+projectId+": "+error.message, "warn");
        if(!res.headersSent) {
          res.status(400);
          res.send('Bad request.');
        }
      }
    });
  }

  startServer() {
    const port = process.env.WS_SERVER_PORT || 17890;
    this.server = this.app.listen(port, () => {
      this.addLog(this.name+' '+this.version+' is running on port '+port);
    });
    // Same class of crash as an unlistened WebSocket error: a listening failure
    // (port busy, EACCES) arrives as an 'error' event, and without a listener it is an
    // uncaught exception. Exit non-zero and let systemd's Restart=always retry, rather
    // than hold a process that accepts nothing.
    this.server.on('error', (err) => {
      try {
        this.addLog('HTTP server error, exiting: '+(err?.message || err), "error");
      } catch (logError) {
        console.error('HTTP server error, exiting: '+(err?.message || err));
      }
      process.exit(1);
    });
  }

  setupWebSocket() {
    const wss = new WebSocketServer({
      server: this.server,
      verifyClient: (info, callback) => {
        if(this.allowedOrigins.includes(info.origin)) {
          callback(true);
          return;
        }
        this.addLog("Rejected websocket connection from origin "+info.origin, "warn");
        callback(false, 403, "Origin not allowed");
      },
    });

    wss.on('connection', async (ws, req) => {
      this.addLog('Client connected');

      // A WebSocket 'error' event with no listener is an uncaught exception: one
      // malformed frame from a client takes the whole process down, for every user.
      // Attached first, because the pre-auth checks below close the socket and return -
      // a socket that is closed while its frame is still bad errors out afterwards, and
      // that is exactly the crash this prevents.
      ws.on('error', (err) => {
        // addLog writes with appendFileSync, and a throw from inside an 'error'
        // listener is itself uncaught - so the handler that stops one crash must not
        // become another.
        try {
          this.addLog('WebSocket connection error: '+(err?.message || err), "warn");
        } catch (logError) {
          console.error('WebSocket connection error (unloggable): '+(err?.message || err));
        }
      });

      let parsedCookies = {};
      try {
        parsedCookies = this.parseCookies(req?.headers?.cookie);
      } catch (err) {
        this.addLog('Error parsing WebSocket cookies: '+err?.message, 'error');
        ws.close(1008, 'Invalid cookies');
        return;
      }

      ws.PHPSESSID = parsedCookies.PHPSESSID;
      ws.projectId = parsedCookies.projectId;
      //verifyClient admitted this origin; audio URLs for this connection are built on it
      ws.origin = req?.headers?.origin;

      this.addLog("projectId: "+ws.projectId, "debug");

      if (!ws.projectId) {
        this.addLog('Closing WebSocket: missing projectId', 'warn');
        ws.close(1008, 'No project id provided');
        return;
      }

      if (!ws.PHPSESSID) {
        this.addLog('Closing WebSocket: missing PHPSESSID', 'warn');
        ws.close(1008, 'No PHP session id provided');
        return;
      }

      ws.on('message', async (message) => {
        let request = null;
        try {
          request = JSON.parse(message);
          //re-checked for every message, so logging out or losing project membership takes effect immediately
          let authResult = await this.authModule.authenticateUser(ws.PHPSESSID, ws.projectId);
          if(!authResult.authenticated) {
            this.addLog("User failed authentication/authorization. Reason: "+authResult.reason, "warn");
            this.sendError(ws, request.callbackID, authResult.reason);
            return;
          }

          let user = authResult.user;
          if(!REQUEST_TYPES.has(request.type)) {
            this.addLog("Unknown request type from user "+user.username, "warn");
            this.sendError(ws, request.callbackID, 'Unknown command');
            return;
          }
          this.addLog(request.type+" from user "+user.username);

          switch (request.type) {
            case 'GETPROTOCOL':
              this.getProtocol(ws, request);
              break;
            case 'GETDOUSERMANAGEMENT':
              this.doUserManagement(ws, request);
              break;
            case 'LOGONUSER':
              console.warn("Request type was LOGONUSER, but it is not supported");
              break;
            case 'GETGLOBALDBCONFIG':
              await this.getDbConfig(ws, request, user, ws.projectId);
              break;
            case 'GETBUNDLELIST':
              await this.getBundleList(ws, request, user, ws.projectId);
              break;
            case 'GETBUNDLE':
              await this.getBundle(ws, request, user, ws.projectId);
              break;
            case 'SAVEBUNDLE':
              await this.saveBundle(ws, request, user, ws.projectId);
              break;
            case 'WHOAMI':
              this.whoAmI(ws, request, user);
              break;
            default:
              this.sendError(ws, request.callbackID, 'Unknown command');
              break;
          }
        } catch (error) {
          //details stay in the log, they may contain server paths
          this.addLog("Error handling "+(REQUEST_TYPES.has(request?.type) ? request.type : "unknown or unparseable")+" request: "+(error?.stack || error), "error");
          this.sendError(ws, request?.callbackID, 'Request failed.');
        }
      });

      ws.on('close', (code, reason) => {
        this.addLog('Client disconnected');
        this.addLog('Close code: '+code+', reason: '+reason, "debug");
      });
    });
  }

  getProtocol(ws, request) {
    const { type, callbackID } = request;
    const response = {
      callbackID,
      data: {
        protocol: 'EMU-webApp-websocket-protocol',
        version: '0.0.2',
      },
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(response));
  }

  doUserManagement(ws, request) {
    const { type, callbackID } = request;
    const userManagementResponse = {
      callbackID,
      data: 'NO',
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(userManagementResponse));
  }

  /**
   * Not part of the EMU-webApp protocol: tells TRATT whose sign-in this is, so
   * it keeps unsaved work per user and can say whose a save must be (SAVEBUNDLE
   * expectedUser) - a shared browser must not save one person's leftovers as
   * the next person who signs in.
   */
  whoAmI(ws, request, user) {
    ws.send(JSON.stringify({
      callbackID: request.callbackID,
      data: { username: user.username },
      status: { type: 'SUCCESS', message: '' },
    }));
  }

  async getDbConfig(ws, request, user, projectId) {
    const { type, callbackID } = request;

    // Send GETGLOBALDBCONFIG response
    const globalDBConfigResponse = {
      callbackID,
      data: this.readDbConfig(projectId),
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(globalDBConfigResponse));
  }

  async getBundleList(ws, request, user, projectId) {
    const { type, callbackID } = request;

    let bundleList = await this.db.collection("bundlelists").findOne({projectId: projectId, owner: user.username});

    let data = [];
    if(bundleList) {
      data = bundleList.bundles;
    }
    if(data.length == 0) {
      //a valid bundlelist (according to emu-webapp) must contain a least one bundle, so this will result in a client side error
      this.addLog("Bundlelist is empty / not found", "warning");
    }

    // Send GETBUNDLELIST response
    const bundleListResponse = {
      callbackID,
      data: data,
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(bundleListResponse));
  }

  async getBundle(ws, request, user, projectId) {
    const { name, session, callbackID } = request;

    if(!await this.assignedBundle(projectId, user.username, session, name)) {
      this.addLog("Refusing bundle "+session+"/"+name+" in project "+projectId+" to "+user.username+": not assigned to them", "warn");
      this.sendError(ws, callbackID, 'This bundle is not assigned to you.');
      return;
    }

    let bundleBasename = name;
    let bundlePath = this.bundlePath(projectId, session, bundleBasename);

    let mediaUrl = mediaBaseUrl(ws.origin, this.allowedOrigins, process.env.MEDIA_FILE_BASE_URL)+"/file/project/"+encodeURIComponent(projectId)+"/session/"+encodeURIComponent(session)+"/file/"+encodeURIComponent(bundleBasename+"."+AUDIO_FILE_EXTENSION);

    //read dbconfig file - this should always exist
    let emuDbConfig = null;
    try {
      emuDbConfig = this.readDbConfig(projectId);
    }
    catch(error) {
      this.addLog("Error reading DBconfig file: "+error, "error");
      this.sendError(ws, callbackID, 'Error reading DBconfig file.');
      return;
    }

    let trackFiles = [];
    emuDbConfig.ssffTrackDefinitions.forEach(trackDef => {
      let trackFilePath = safeJoinedPath(bundlePath, bundleBasename+"."+safePathComponent(trackDef.fileExtension, "fileExtension"));

      this.addLog("Attempting to read "+trackDef.name+" track file: "+trackFilePath, "debug");

      if(fs.existsSync(trackFilePath)) {
        this.addLog("Found "+trackDef.name+" track file: "+trackFilePath, "debug");
        let trackData = fs.readFileSync(trackFilePath);
        let trackDataBase64 = trackData.toString('base64');
        let trackFile = {
          data: trackDataBase64,
          encoding: "BASE64",
          fileExtension: trackDef.fileExtension,
        };
        trackFiles.push(trackFile);
      }
      else {
        this.addLog("Track file not found: "+trackFilePath, "warn");
      }
    });

    if(!fs.existsSync(safeJoinedPath(bundlePath, bundleBasename+"."+AUDIO_FILE_EXTENSION))) {
      this.addLog("Audio file not found in bundle "+bundlePath, "error");
      this.sendError(ws, callbackID, 'Audio file not found.');
      return;
    }

    //load the <bundlename>_annot.json data
    let annotationData = null;
    let version = null;
    try {
      ({ annotation: annotationData, version } = this.getBundleAnnotationData(bundlePath, bundleBasename));
    }
    catch(error) {
      this.addLog("Error reading annotation file: "+error, "error");
      this.sendError(ws, callbackID, 'Error reading annotation file.');
      return;
    }

    let bundleData = {
      annotation: annotationData,
      mediaFile: {
        data: mediaUrl,
        encoding: "GETURL"
      },
      ssffFiles: trackFiles,
    };
    //Not part of the EMU-webApp protocol, so only for a client that asks (TRATT):
    //Artic validates this response against a schema that refuses any field it
    //does not know, and would not open the bundle at all.
    if(request.withVersion === true) {
      bundleData.annotationVersion = version;
    }

    // Send GETBUNDLE response
    const bundleResponse = {
      callbackID,
      data: bundleData,
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    ws.send(JSON.stringify(bundleResponse));
  }


  //the user's bundle list entry for session/name in this project, or null (see bundleAccess.js)
  async assignedBundle(projectId, username, session, name) {
    const bundleList = await this.db.collection("bundlelists").findOne({projectId: projectId, owner: username});
    return findAssignedBundle(bundleList, session, name);
  }

  //the annotation and its version (sha256 of the file's bytes)
  getBundleAnnotationData(bundlePath, bundleName) {
    const bytes = fs.readFileSync(safeJoinedPath(bundlePath, bundleName+"_annot.json"));
    return { annotation: JSON.parse(bytes.toString('utf8')), version: annotationVersion(bytes) };
  }

  //atomic: a reader sees the old file or the new one, never half of one
  writeFileAtomic(path, data) {
    const tmp = path+".tmp-"+process.pid+"-"+Date.now();
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, path);
    }
    catch(error) {
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }

  async saveBundle(ws, request, user, projectId) {
    const { type, callbackID } = request;
    let reqData = request.data;
    if(typeof reqData?.annotation?.name !== "string") {
      this.sendError(ws, callbackID, 'Invalid bundle data.');
      return;
    }
    let bundleName = reqData.annotation.name.replace(/_annot\.json$/, '');

    //TRATT says whose work this is: a save made for one person must not go through
    //under the sign-in of whoever uses the browser next
    if(reqData.expectedUser !== undefined && reqData.expectedUser !== user.username) {
      this.addLog("Refusing save of "+reqData.session+"/"+bundleName+" made for another user, now signed in as "+user.username, "warn");
      this.sendError(ws, callbackID, 'Signed in to Visp as a different user than the one who made these changes.');
      return;
    }

    let bundleList = await this.db.collection("bundlelists").findOne({projectId: projectId, owner: user.username});
    if(!findAssignedBundle(bundleList, reqData.session, bundleName)) {
      this.addLog("Refusing to save bundle "+reqData.session+"/"+bundleName+" in project "+projectId+" for "+user.username+": not assigned to them", "warn");
      this.sendError(ws, callbackID, 'This bundle is not assigned to you.');
      return;
    }

    let bundlePath = this.bundlePath(projectId, reqData.session, bundleName);
    //never create bundles, only update existing ones
    if(!fs.existsSync(bundlePath)) {
      this.addLog("Refusing to save to non-existent bundle "+bundlePath, "warn");
      this.sendError(ws, callbackID, 'Bundle not found.');
      return;
    }

    const dbConfig = this.readDbConfig(projectId);

    //only the SSFF tracks declared in the database config may be written, and nothing else (e.g. the audio file),
    //and only what really is base64-encoded SSFF: Buffer.from() decodes anything without complaint
    let allowedExtensions = dbConfig.ssffTrackDefinitions.map(trackDef => trackDef.fileExtension);
    let ssffFiles = Object.values(reqData.ssffFiles || {});
    let decodedSsffFiles = [];
    for(let ssffFile of ssffFiles) {
      const decoded = allowedExtensions.includes(ssffFile?.fileExtension) && ssffFile.encoding?.toUpperCase() === "BASE64" && isStrictBase64(ssffFile.data)
        ? Buffer.from(ssffFile.data, 'base64')
        : null;
      if(!decoded || !isSsff(decoded)) {
        this.addLog("Refusing to save SSFF file with extension "+ssffFile?.fileExtension+" and encoding "+ssffFile?.encoding+" to "+bundlePath, "warn");
        this.sendError(ws, callbackID, 'Invalid SSFF file.');
        return;
      }
      decodedSsffFiles.push({ fileExtension: ssffFile.fileExtension, decoded });
    }

    //From here to the writes nothing awaits, so no other save of this bundle can
    //run in between: the version check and the write are one step.
    const { annotation: current, version: currentVersion } = this.getBundleAnnotationData(bundlePath, bundleName);
    if(reqData.baseVersion !== undefined && reqData.baseVersion !== currentVersion) {
      this.addLog("Refusing stale save of "+reqData.session+"/"+bundleName+" by "+user.username+": the bundle changed since it was read", "warn");
      this.sendError(ws, callbackID, 'STALE: the bundle was changed in Visp since it was opened.');
      return;
    }
    let problem = annotationProblem(reqData.annotation, current, bundleName, dbConfig);
    //a save that names its level (TRATT) may change that level only
    if(!problem && reqData.level !== undefined) {
      problem = levelProblem(dbConfig, reqData.level) || outsideLevelChange(reqData.annotation, current, reqData.level);
    }
    if(problem) {
      this.addLog("Refusing save of "+reqData.session+"/"+bundleName+" by "+user.username+": "+problem, "warn");
      this.sendError(ws, callbackID, 'Invalid annotation: '+problem+'.');
      return;
    }

    for(let { fileExtension, decoded } of decodedSsffFiles) {
      this.writeFileAtomic(safeJoinedPath(bundlePath, bundleName+"."+safePathComponent(fileExtension, "fileExtension")), decoded);
    }
    const annotationBytes = Buffer.from(JSON.stringify(reqData.annotation, null, 2));
    this.writeFileAtomic(safeJoinedPath(bundlePath, bundleName+"_annot.json"), annotationBytes);

    //Only this one entry: writing back the whole array would restore an
    //assignment an admin removed while this save was running.
    const updated = await this.db.collection("bundlelists").updateOne(
      {projectId: projectId, owner: user.username},
      {$set: {
        "bundles.$[entry].finishedEditing": reqData.finishedEditing ? true : false, //make sure it's a boolean
        "bundles.$[entry].comment": typeof reqData.comment === "string" ? reqData.comment : "",
      }},
      {arrayFilters: [{"entry.session": reqData.session, "entry.name": bundleName}]}
    );
    if(!updated.matchedCount) {
      this.addLog("Bundlelist not found when saving bundle", "error");
    }

    // Send SAVEBUNDLE response
    const saveBundleResponse = {
      callbackID,
      status: {
        type: 'SUCCESS',
        message: '',
      },
    };
    //not part of the EMU-webApp protocol: the version the next save is based on,
    //for a client that uses versions (TRATT); Artic gets the reply it always got
    if(reqData.baseVersion !== undefined || reqData.level !== undefined) {
      saveBundleResponse.data = { annotationVersion: annotationVersion(annotationBytes) };
    }
    ws.send(JSON.stringify(saveBundleResponse));
  }

  connectToMongo(dbName) {
    MongoClient.connect(process.env.MONGO_URI)
      .then(client => {
        this.addLog('Connected to MongoDB');

        // Select the database
        this.db = client.db(dbName);
      })
      .catch(err => {
        this.addLog('Failed to connect to MongoDB: '+(err?.message || err), "error");
        //A connect failure must not leave a half-alive server behind: every
        //database-backed request would fail forever while systemd reports the unit as
        //running. Exit non-zero so systemd's Restart=always retries the connection.
        process.exit(1);
      });
  }

  addLog(msg, level = 'info') {
    //request fields end up in messages: no forged lines or terminal escapes
    msg = logSafe(msg);
    let levelMsg = new String(level).toUpperCase();
    if(levelMsg == "DEBUG" && this.logLevel == "INFO") {
      return;
    }

    let levelMsgColor = levelMsg;

    if(levelMsg == "WARNING") { levelMsg = "WARN"; }

    switch(levelMsg) {
      case "INFO":
        levelMsgColor = colors.green(levelMsg);
      break;
      case "WARN":
        levelMsgColor = colors.yellow(levelMsg);
      break;
      case "ERROR":
        levelMsgColor = colors.red(levelMsg);
      break;
      case "DEBUG":
        levelMsgColor = colors.cyan(levelMsg);
      break;
    }

    let logMsg = new Date().toLocaleDateString("sv-SE")+" "+new Date().toLocaleTimeString("sv-SE");
    let printMsg = logMsg+" ["+levelMsgColor+"] "+msg;
    let writeMsg = logMsg+" ["+levelMsg+"] "+msg+"\n";

    let logFile = "logs/annotation-server.log";
    switch(level) {
      case 'info':
        console.log(printMsg);
        fs.appendFileSync(logFile, writeMsg);
        break;
      case 'warn':
        console.warn(printMsg);
        fs.appendFileSync(logFile, writeMsg);
        break;
      case 'error':
        console.error(printMsg);
        fs.appendFileSync(logFile, writeMsg);
        break;
      default:
        console.error(printMsg);
        fs.appendFileSync(logFile, writeMsg);
    }
  }

}

new AnnotationServer();
