/*jslint node: true, esversion: 6 */

const Dgram = require('dgram');
const Events = require('events');
const os = require('os');
const fs = require('fs');
const Semaphore = require('semaphore');
const Async = require('async');
const debug = require('debug')('xpl-api');

class XplAPI extends Events.EventEmitter {
	constructor(configuration) {
		super();

		var hostName = os.hostname();
		if (hostName.indexOf('.') > 0) {
			hostName = hostName.substring(0, hostName.indexOf('.'));
		}

		configuration = configuration || {};
		this._configuration = configuration;

		this._keepMessageOrder = (configuration.keepMessageOrder === true);

		var xplLog = this._configuration.xplLog;
		if (xplLog === true) {
			this._log = console.log.bind(console);

		} else if (typeof (xplLog) === "function") {
			this._log = xplLog.bind(this);

		} else if (debug.enabled) {
			this._log = debug;
		}

		configuration.xplPort = configuration.xplPort || 3865;
		configuration.hubSupport = configuration.hubSupport || false;
		configuration.socketType = configuration.socketType || 'udp4';
		// configuration.ttl = 0;
		configuration.hubPingDelaySecond = configuration.hubPingDelaySecond || 60 * 4;
		configuration.xplSource = configuration.xplSource || "nodejs." + hostName +
			"-" + process.pid;
		configuration.xplTarget = configuration.xplTarget || "*";
		// configuration.promiscuousMode = configuration.promiscuousMode
		// configuration.log = true;

		this._broadcastOutputSocketSemaphore = Semaphore(1);
		this._broadcastInputSocketSemaphore = Semaphore(1);
		this._localSocketSemaphore = Semaphore(1);

		this._waitingMessages = [];

		if (!this._configuration.localAddress) {
			var nis = os.networkInterfaces();

			var family = (this._configuration.socketType == "udp6") ? "IPv6" : "IPv4";

			for (var name in nis) {
				var addrs = nis[name];

				for (var i = 0; i < addrs.length; i++) {
					var addr = addrs[i];

					if (addr.internal || addr.family != family) {
						continue;
					}

					this._configuration.localAddress = addr.address;
					break;
				}

				if (this._configuration.localAddress) {
					break;
				}
			}

			if (!this._configuration.localAddress) {
				this._configuration.localAddress = (this._configuration.socketType == "udp6") ? "::1" : "127.0.0.1";
			}
		}
		if (!this._configuration.broadcastAddress) {
			var ba = this._configuration.localAddress;
			var idx = ba.lastIndexOf(".");
			if (idx > 0) {
				ba = ba.substring(0, idx) + ".255";
			}

			this._configuration.broadcastAddress = ba;
		}

		debug("constructor", "Computed configuration=", this._configuration);

		if (configuration.verbose) {
			this._log("localAddress=", this._configuration.localAddress,
				" broadcastAddress=", this._configuration.broadcastAddress);
		}
	}

	/**
	 * Specify valid options for Commander command line
	 *
	 * @param {*} commander
	 */
	static fillCommander(commander) {
		commander.option("--xplPort <port>", "Set the xpl port", parseInt);
		commander.option("--hubSupport", "Enable xpl hub support");
		commander.option("--socketType <socketType>", "Specify the type of socket (udp4/udp6)");
		commander.option("--broadcastAddress <address>", "Specify the broadcastAddress");
		commander.option("--hubPingDelaySecond <sec>", "Specify the delay between 2 hub heart beats in second", parseInt);
		commander.option("--xplSource <name>", "Specify the source in XPL message");
		commander.option("--xplTarget <name>", "Specify the target in XPL message");
		commander.option("--xplLog", "Verbose XPL layer");
	}

	/**
	 * Default log method
	 *
	 * @private
	 */
	_log() {
		// this function is replaced by the constructor
		console.log.apply(console, arguments);
	}

	/**
	 * Start the XPL HUB
	 *
	 * @param {Function} callback
	 * @private
	 */
	_startHub(callback) {
		// return callback("no");

		debug("startHub: Starting ... try to allocate port");
		this._getInputBroadcastSocket((error, socket, address) => {

			if (error) {
				this._log("startHub: Hub is not started ", error);

				return callback(error);
			}

			debug("startHub: Hub started ", address, socket);

			this._hubClients = {};

			var processMessage = (message, address, buffer) => {
				debug("Hub receive message from=", address, " message=", message);

				// XPL Message

				// An heart beat ? Register it

				var clients = this._hubClients;

				if (message.bodyName == "hbeat.app") {
					var key = address.address + ":" + address.port;
					var now = Date.now();
					clients[key] = {
						ttl: now + this._configuration.hubPingDelaySecond * 1000 * 2,
						address: address.address,
						port: address.port
					};

					debug("Register new client", clients[key]);

					return;
				}

				this._forwardMessage(clients, message, buffer, (error) => {
					if (error) {
						console.error("Forward error: ", error);
					}
				});
			};

			this.on("message", processMessage);
			this.on("hub", processMessage);

			callback(null);
		});
	}

	/**
	 * Forward a message to other XPL clients.
	 *
	 * @param clients
	 * @param message
	 * @param buffer
	 * @param {Function} callback
	 * @private
	 */
	_forwardMessage(clients, message, buffer, callback) {
		var now = Date.now();

		this._getLocalSocket((error, socket) => {
			if (error) {
				debug("_forwardMessage", "Can not forward message to client ", error);

				callback(error);
				return;
			}

			debug("_forwardMessage", "Forward message to clients=", clients, " now=", now);

			Async.forEachOf(clients, (client, clientName, callback) => {
				if (client.ttl < now) {
					debug("DELETE hub client=", client);
					delete clients[clientName];

					callback();
					return;
				}
				debug("_forwardMessage", "Process hub client=", client);

				debug("_forwardMessage", "Forward message to " + client.address + ":" + client.port +
					" => " + message);

				socket.send(buffer, 0, buffer.length, client.port, client.address, (error) => {
					if (error) {
						console.error("Can not forward message. error=", error);
					}

					callback();
				});

			}, (error) => {
				if (error) {
					console.error(error);
					return callback(error);
				}

				debug("_forwardMessage", "Message forwarded to all clients");

				callback();
			});
		});
	}

	/**
	 *
	 * @param {Function} callback
	 * @private
	 */
	_connectHub(callback) {
		debug("_connectHub", "Try to connect to the hub ...");

		this._getOutputBroadcastSocket((err, socket, address) => {
			if (err) {
				this._log("Can not connect to the hub ...", err);
				return callback(err);
			}

			debug("_connectHub", "Connecting to the hub ...");

			this._hubInterval = setInterval(() => {
				this._hubPing(address, socket);

			}, this._configuration.hubPingDelaySecond * 1000);

			this._hubPing(address, socket);

			return callback(null, address);
		});
	}

	/**
	 *
	 * @param message
	 * @param [headerName]
	 * @param [target]
	 * @param [source]
	 * @returns {*|{}}
	 * @private
	 */
	_fillHeader(message, headerName, target, source) {
		message = message || {};

		if (source && /^;/.exec(source)) {
			source = this._configuration.xplSource + ' ' + source;
		}

		message.header = {
			hop: 1,
			source: source || this._configuration.xplSource,
			target: target || this._configuration.xplTarget
		};
		if (headerName) {
			message.headerName = headerName;
		}

		return message;
	}

	/**
	 *
	 * @param address
	 * @param socket
	 * @private
	 */
	_hubPing(address, socket) {
		debug("_hubPing", "send heart beat !");
		var interval = Math.floor(this._configuration.hubPingDelaySecond / 60);
		if (interval < 1) {
			interval = 1;
		}

		var message = this._fillHeader({
			bodyName: "hbeat.app",
			body: {
				interval: interval,
				port: address.port,
				"remote-ip": address.address || this._configuration.localAddress
			}
		}, "xpl-stat");

		var buffer = this._xplMessageToBuffer(message);

		debug("_hubPing", "buffer=", buffer.toString(), " port=",
			this._configuration.xplPort, " address=",
			this._configuration.broadcastAddress);

		socket.send(buffer, 0, buffer.length, this._configuration.xplPort,
			this._configuration.broadcastAddress, (error, bytes) => {
				debug("_hubPing", "Send heart beat error=", error, "bytes=", bytes);
			});
	}

	/**
	 * Bind the socket.
	 * If messages are in the waiting pool, they will be sent.
	 *
	 * @param {Function} callback
	 */
	bind(callback) {
		this.close();

		if (!this._configuration.hubSupport) {
			this._connectHub(callback);
			return;
		}

		this._startHub((error) => {
			if (error) {
				this._log("Start Hub return error (a XPL-HUB is already launched ?)", error);
				// A HUB is already present !

				this._connectHub(callback);
				return;
			}

			debug("bind", "Start Hub succeed");

			var waitingMessages = this._waitingMessages;
			this._waitingMessages = undefined;
			if (waitingMessages) {
				Async.each(waitingMessages, (message, callback) => {
					this.sendBufferMessage(message, callback);

				}, () => {
					debug("bind", "Messages sent !");

					callback();
				});

				return;
			}

			// Hub created
			callback(null);
		});
	}

	/**
	 * Send a XPL message.
	 *
	 * If the socket is not bound (see #bind() method), the message will be stored in a waiting pool.
	 *
	 * @param {string} headerName
	 * @param {Object} header
	 * @param {string} bodyName
	 * @param {Object} body
	 * @param {Function} callback
	 */
	sendMessage(headerName, header, bodyName, body, callback) {
		var message = {
			headerName: headerName,
			header: header,
			bodyName: bodyName,
			body: body
		};

		this.send(message, callback);
	}

	/**
	 *
	 * @param {Object} xplMessage - The message
	 * @param {string} xplMessage.headerName - Header name
	 * @param {Object} [xplMessage.header] - Header content
	 * @param {string} [xplMessage.bodyName] - Body name
	 * @param {Object} [xplMessage.body] - Body content
	 * @returns {Buffer}
	 * @private
	 */
	_xplMessageToBuffer(xplMessage) {

		var message = xplMessage.headerName + "\n{\n";
		var header = xplMessage.header;
		if (header) {
			for (var n in header) {
				var h = this._encodeValue(header[n]);
				message += n + "=" + h + "\n";
			}
		}
		message += "}\n";

		if (xplMessage.bodyName) {
			message += xplMessage.bodyName + "\n{\n";

			var body = xplMessage.body;
			if (body) {
				for (var n2 in body) {
					var b = this._encodeValue(body[n2]);
					message += n2 + "=" + b + "\n";
				}
			}
			message += "}\n";
		}

		var buffer = new Buffer(message);

		return buffer;
	}

	/**
	 * Send a XPL message
	 *
	 * If the socket is not bound (see #bind() method), the message will be stored in a waiting pool.
	 *
	 * @param {Object} xplMessage - The message
	 * @param {string} xplMessage.headerName - Header name
	 * @param {Object} [xplMessage.header] - Header content
	 * @param {string} [xplMessage.bodyName] - Body name
	 * @param {Object} [xplMessage.body] - Body content
	 * @param {Function} callback
	 */
	send(xplMessage, callback) {
		if (!xplMessage.headerName) {
			return callback(new Error("Invalid XPL message format (no header name)", xplMessage));
		}

		var buffer = this._xplMessageToBuffer(xplMessage);

		this.sendBufferMessage(buffer, callback);
	}

	/**
	 * Send the message
	 *
	 * If the socket is not bound (see #bind() method), the message will be stored in a waiting pool.
	 *
	 * @param {Buffer} buffer
	 * @param {Function} callback
	 * @private
	 */
	sendBufferMessage(buffer, callback) {

		if (this._waitingMessages) {
			if (debug.enabled) {
				debug("sendBufferMessage", "Delayed message=", buffer.toString());
			}

			this._waitingMessages.push(buffer);
			if (!callback) {
				return;
			}

			return callback(null);
		}

		if (debug.enabled) {
			debug("sendBufferMessage", "Send buffer message=", buffer.toString());
		}

		this._getOutputBroadcastSocket((error, socket) => {
			if (error) {
				if (!callback) {
					this._log("xpl.SendBufferMessage: error=", error);
					return;
				}
				return callback(error);
			}

			if (debug.enabled) {
				debug("sendBufferMessage", "Send buffer to", this._configuration.broadcastAddress, ":", this._configuration.xplPort);
			}

			socket.send(buffer, 0, buffer.length, this._configuration.xplPort,
				this._configuration.broadcastAddress, (error, bytes) => {
					if (error) {
						if (!callback) {
							this._log("xpl.SendBufferMessage: error=", error);
							return;
						}
						return callback(error);
					}

					if (!callback) {
						return;
					}
					callback(null, socket);
				});
		});
	}

	/**
	 *
	 * @param {Function} callback
	 * @private
	 */
	_getLocalSocket(callback) {

		this._getSocket(this._localSocketSemaphore, "_localSocket",
			this._configuration.localAddress, 0, false, callback);
	}

	/**
	 *
	 * @param {Function} callback
	 * @private
	 */
	_getOutputBroadcastSocket(callback) {

		this._getSocket(this._broadcastOutputSocketSemaphore,
			"_outputBroadcastSocket", this._configuration.localAddress, 0, true,
			callback);
	}

	/**
	 *
	 * @param {Function} callback
	 * @private
	 */
	_getInputBroadcastSocket(callback) {

		var ba = (os.platform() == "win32") ? "" : this._configuration.broadcastAddress;

		this._getSocket(this._broadcastInputSocketSemaphore,
			"_inputBroadcastSocket", ba, this._configuration.xplPort, true, callback);
	}

	/**
	 *
	 * @param sem
	 * @param cacheName
	 * @param address
	 * @param port
	 * @param broadcastType
	 * @param callback
	 * @private
	 */
	_getSocket(sem, cacheName, address, port, broadcastType, callback) {

		if (debug.enabled) {
			debug("_getSocket", "cacheName=", cacheName, "get socket for address=", address, "port=", port, "broadcast=", broadcastType);
		}

		sem.take(() => {

			var socket = this[cacheName];
			if (socket) {
				sem.leave();
				return callback(null, socket, socket.address());
			}

			this._connect(address, port, broadcastType, (error, socket, address) => {
				if (debug.enabled) {
					debug("_getSocket", "cacheName=", cacheName, "Connection result error=",
						error, "address=", address);
				}

				if (error) {
					this[cacheName] = null;
					sem.leave();
					return callback(error);
				}

				this[cacheName] = socket;
				sem.leave();

				callback(null, socket, address);
			});
		});
	}

	/**
	 *
	 * @param address
	 * @param port
	 * @param broadcastType
	 * @param callback
	 * @private
	 */
	_connect(address, port, broadcastType, callback) {

		var config = this._configuration;

		var closeState = false;

		debug("_connect", "address=", address, "port=", port, "broadcastType=", broadcastType);

		var socket = Dgram.createSocket(config.socketType);

		var listening = false;

		socket.on("close", () => {
			closeState = true;
		});

		socket.on("message", (buffer, address) => {
			var message = buffer.toString();

			var packet;

			try {
				packet = this._parseXPLMessage(message, address);

			} catch (x) {

				if (debug.enabled) {
					debug("_connect", "Can not validate packet message=", message, " from=", address,
						" error=", x);
				}

				this.emit("validationError", x, message, address);
				return;
			}

			if (!config.promiscuousMode) {
				if (packet.header) {
					var target = packet.header.target;

					if (target && target !== '*' && target !== config.xplSource) {
						debug("_connect", "Ignore packet=", packet, " from=", address);

						if (this._hubClients) {
							// Hub mode !

							this.emit("hub", packet, address, buffer);
						}

						return;
					}
				}
			}

			if (packet) {

				if (debug.enabled) {
					debug("_connect", "Emit received packet=", packet, "from=", address.address, ":", address.port);
				}

				this.emit("message", packet, address, buffer);

				if (packet.headerName) {
					this.emit("xpl:" + packet.headerName, packet, address);
				}
				if (packet.bodyName) {
					this.emit("xpl:" + packet.bodyName, packet, address);
				}
			}
		});

		socket.on("error", (error) => {
			this._log("_connect: socket error", error, error.stack);
			socket.close();

			if (!listening) {
				return callback(error, null);
			}

			this.emit("error", error);
		});

		if (config.ttl) {
			socket.setTTL(config.ttl);
			debug("_connect", "Socket: set TTL to", config.ttl);
		}

		debug("_connect", "bind address=", address, " port=", port);

		socket.on("listening", (error) => {
			if (closeState) {
				return callback("error", new Error("Socket closed"));
			}

			if (error) {
				this._log("Socket bind failed error=", error);

				return callback(error);
			}

			if (listening) {
				return;
			}

			if (broadcastType) {
				socket.setBroadcast(true);
				debug("_connect", "Socket: set broadcast type to TRUE");
			}

			listening = true;

			var address = socket.address();

			debug("_connect", "Bind succeed on", address.address, ":", address.port);

			var waitingMessages = this._waitingMessages;
			this._waitingMessages = undefined;
			if (waitingMessages) {
				return Async.each(waitingMessages, (message, callback) => {

					this.sendBufferMessage(message, callback);

				}, (error) => {
					callback(error, socket, address);
				});
			}

			callback(null, socket, address);
		});

		socket.bind(port, address);
	}

	/**
	 * Close the connexion
	 *
	 * @param {Function} [callback]
	 */
	close(callback) {
		if (this._hubInterval) {
			clearInterval(this._hubInterval);
			this._hubInterval = undefined;
		}

		var somethingClosed = false;

		if (this._localSocket) {
			this._localSocket.close();
			this._localSocket = undefined;
			somethingClosed = true;
		}
		if (this._inputBroadcastSocket) {
			this._inputBroadcastSocket.close();
			this._inputBroadcastSocket = undefined;
			somethingClosed = true;
		}
		if (this._outputBroadcastSocket) {
			this._outputBroadcastSocket.close();
			this._outputBroadcastSocket = undefined;
			somethingClosed = true;
		}

		if (somethingClosed) {
			this.emit("close");
		}

		this._hubClients = undefined;

		if (callback) {
			callback();
		}
	}

	/**
	 * Parse XPL message
	 *
	 * @param {string} buffer
	 * @param {Object} address
	 * @returns {{timestamp: number, from: Object}}
	 * @private
	 */
	_parseXPLMessage(buffer, address) {
		var lines = buffer.replace(/\r/gm, "").split("\n");

		var dest = {
			timestamp: Date.now(),
			from: address,
		};
		this._parseXPLBlock(dest, "headerName", "header", lines);
		this._parseXPLBlock(dest, "bodyName", "body", lines);

		var headSchemas = this._headSchemas;
		if (headSchemas) {
			var headSchema = headSchemas[dest.headName];
			if (headSchema) {
				this._validSchema(headSchema, dest.head);
			}
		}

		var validated = false;
		var bodySchemas = this._bodySchemas;
		if (bodySchemas) {
			var bodySchema = bodySchemas[dest.bodyName];
			if (bodySchema) {
				this._validSchema(bodySchema, dest.body);
				validated = true;
			}
		}

		if (this._configuration.forceBodySchemaValidation && !validated) {
			var e = new Error("No body schema for '" + dest.bodyName + "'.");
			e.code = "NO_BODY_SCHEMA";
			throw e;
		}

		return dest;
	}

	/**
	 * Parse a XPL block
	 *
	 * @param {Object} dest
	 * @param {string} blockName
	 * @param {string} blockVar
	 * @param {string[]} lines
	 * @private
	 */
	_parseXPLBlock(dest, blockName, blockVar, lines) {
		dest[blockName] = lines.shift();
		if (lines.shift() != "{") {
			return;
		}
		var header = {};
		var order = null;
		if (this._keepMessageOrder) {
			order = [];
			dest.$order = order;
		}
		dest[blockVar] = header;
		for (; ;) {
			var line = lines.shift();
			if (line == "}") {
				break;
			}
			var r = /^([^=]+)=(.*)$/.exec(line);
			if (!r) {
				continue;
			}
			var name = r[1];
			var value = this._decodeValue(r[2]);

			if (order) {
				order.push(name);
			}
			header[name] = value;
		}
	}

	/**
	 *
	 * @param {string|*} text
	 * @returns {string}
	 * @private
	 */
	_encodeValue(text) {
		if (typeof(text) !== "string") {
			return text;
		}
		text = text.replace(/\\/g, '\\\\');
		text = text.replace(/\n/g, '\\n');

		return text;
	}

	/**
	 *
	 * @param {string} text
	 * @returns {string}
	 * @private
	 */
	_decodeValue(text) {
		text = text.replace(/\\n/g, '\n');
		text = text.replace(/\\\\/g, '\\');

		return text;
	}

	/**
	 *
	 * @param body
	 * @param bodyName
	 * @param callback
	 * @param [headerName]
	 * @param [target]
	 * @param [source]
	 * @private
	 */
	_sendXplX(body, bodyName, callback, headerName, target, source) {

		var message = this._fillHeader({
			bodyName: bodyName,
			body: body
		}, headerName, target, source);

		this.send(message, callback);
	}

	/**
	 * Send a XPL command
	 *
	 * @param {string} command
	 * @param {Object} body
	 * @param {string} [bodyName]
	 * @param {string} [target]
	 * @param {string} [source]
	 * @param {Function} callback
	 */
	sendXplCommand(command, body, bodyName, target, source, callback) {
		if (typeof(source) === "function") {
			callback = source;
			source = null;
		}
		if (typeof(target) === "function") {
			callback = target;
			target = null;
		}
		if (typeof(bodyName) === "function") {
			callback = bodyName;
			bodyName = null;
		}

		this._sendXplX(body, bodyName, callback, command, target, source);
	}

	/**
	 * Send a XPL Stat message
	 *
	 * @param {Object} body
	 * @param {string} [bodyName='sensor.basic']
	 * @param {string} [target]
	 * @param {string} [source]
	 * @param {Function} callback
	 */
	sendXplStat(body, bodyName, target, source, callback) {
		if (arguments.length === 4 && typeof(source) === "function") {
			callback = source;
			source = null;
		}
		if (arguments.length === 3 && typeof(target) === "function") {
			callback = target;
			target = null;
		}
		if (arguments.length === 2 && typeof(bodyName) === "function") {
			callback = bodyName;
			bodyName = null;
		}

		if (!bodyName || typeof (bodyName) !== "string") {
			bodyName = "sensor.basic";
		}

		this._sendXplX(body, bodyName, callback, "xpl-stat", target, source);
	}

	/**
	 * Send a XPL Trig message
	 *
	 * @param {Object} body
	 * @param {string} [bodyName='sensor.basic']
	 * @param {string} [target]
	 * @param {string} [source]
	 * @param {Function} callback
	 */
	sendXplTrig(body, bodyName, target, source, callback) {
		if (arguments.length === 4 && typeof(source) === "function") {
			callback = source;
			source = null;
		}
		if (arguments.length === 3 && typeof(target) === "function") {
			callback = target;
			target = null;
		}
		if (arguments.length === 2 && typeof(bodyName) === "function") {
			callback = bodyName;
			bodyName = null;
		}

		if (!bodyName || typeof (bodyName) !== "string") {
			bodyName = "sensor.basic";
		}

		this._sendXplX(body, bodyName, callback, "xpl-trig", target, source);
	}


	/**
	 * Send a XPL command
	 *
	 * @param {Object} body
	 * @param {string} [bodyName='sensor.basic']
	 * @param {string} [target]
	 * @param {string} [source]
	 * @param {Function} callback
	 */
	sendXplCmnd(body, bodyName, target, source, callback) {
		if (arguments.length === 4 && typeof(source) === "function") {
			callback = source;
			source = null;
		}
		if (arguments.length === 3 && typeof(target) === "function") {
			callback = target;
			target = null;
		}
		if (arguments.length === 2 && typeof(bodyName) === "function") {
			callback = bodyName;
			bodyName = null;
		}

		if (!bodyName || typeof (bodyName) !== "string") {
			bodyName = "sensor.request";
		}

		this._sendXplX(body, bodyName, callback, "xpl-cmnd", target, source);
	}

	/**
	 * Add Schema for a specific header name.
	 *
	 * @param {string} headName
	 * @param {Object} schema
	 */
	addHeadSchema(headName, schema) {
		var headSchemas = this._headSchemas;
		if (!headSchemas) {
			headSchemas = {};
			this._headSchemas = headSchemas;
		}

		headSchemas[headName] = schema;
	}

	/**
	 * Add Schema for a specific body name.
	 *
	 * @param {string} bodyName
	 * @param {Object} schema
	 */
	addBodySchema(bodyName, schema) {
		var bodySchemas = this._bodySchemas;
		if (!bodySchemas) {
			bodySchemas = {};
			this._bodySchemas = bodySchemas;
		}

		bodySchemas[bodyName] = schema;
	}

	/**
	 * Valid schema for an object
	 *
	 * @param schema
	 * @param obj
	 * @private
	 */
	_validSchema(schema, obj) {

		for (var fieldName in obj) {
			var desc = schema.properties[fieldName];
			if (!desc) {
				let e = new Error("Unknown field '" + fieldName + "'");
				e.code = "UNKNOWN_FIELD";
				throw e;
			}

			var value = obj[fieldName];
			if (value === undefined) {
				let e = new Error("Field '" + fieldName + "' has not value");
				e.code = "NO_VALUE";
				throw e;
			}

			var newValue;

			switch (desc.type) {
				case "integer":
				case "float":
				case "number":
					newValue = (desc.type === "integer") ? parseInt(value, 10) : parseFloat(value);

					if (isNaN(newValue)) {
						let e = new Error("Invalid integer field='" + fieldName + "' value=" + value);
						e.code = "NOT_A_NUMBER";
						throw e;
					}
					if (typeof (desc.minimum) === 'number') {
						if (newValue < desc.minimum) {
							let e = new Error("Invalid range of integer field='" + fieldName + "' value=" + value + " minimum=" + desc.minimum);
							e.code = "RANGER_ERROR";
							throw e;
						}
					}
					if (typeof (desc.maximum) === 'number') {
						if (newValue > desc.maximum) {
							let e = new Error("Invalid range of integer field='" + fieldName + "' value=" + value + " maximum=" + desc.maximum);
							e.code = "RANGER_ERROR";
							throw e;
						}
					}
					obj[fieldName] = newValue;
					break;

				case "boolean":
					var v = value.toLowerCase();
					obj[fieldName] = !(v == "f" || v == "0" || v == "false" || v == "no" || v == "n" || v == "[]");
					break;

				case "string":
					var pattern = desc.pattern;
					if (pattern) {
						if (typeof (pattern) === "string") {
							pattern = new RegExp(pattern);
							desc.pattern = pattern;
						}

						if (!pattern.test(value)) {
							let e = new Error("Regexp has not matched field='" + fieldName + "' value=" + value + " regExp=" + pattern);
							e.code = "REGEXP_NOT_MATCHED";
							throw e;
						}
					}

					var _enum = desc.enum;
					if (_enum && _enum.indexOf) {
						if (_enum.indexOf(value) < 0) {
							let e = new Error("String is not in the enum field='" + fieldName + "' value=" + value + " enum=" + _enum);
							e.code = "NOT_IN_ENUM";
							throw e;
						}
					}
					break;

				default:
					let e = new Error("Type is not implemented '" + desc.type + "'");
					e.code = "NOT_IMPLEMENTED";
					throw e;
			}
		}

		if (schema.required) {
			schema.required.forEach((name) => {
				if (!(name in obj)) {
					let e = new Error("Required field not specified fieldName='" + name + "'");
					e.code = "REQUIRED_FIELD_NOT_SPECIFIED";
					throw e;
				}
			});
		}
	}

	static _loadDeviceAliasesFile(file, ds, configuration) {
		function load() {
			debug("_loadDeviceAliasesFile", "load file content: path=", file);
			fs.readFile(file, (error, data) => {
				if (error) {
					console.error("Can not load device aliases=", file, "error=", error);
					return;
				}

				let r = JSON.parse(data);

				for (var n in r) {
					if (!r.hasOwnProperty(n)) {
						continue;
					}
					ds[n] = r[n];
				}
			});
		}

		fs.watch(file, load);

		load();
	}

	/**
	 * Load device aliases
	 *
	 *
	 * @param deviceAliases
	 * @returns {{}}
	 */
	static loadDeviceAliases(deviceAliases, configuration) {
		var ds = {};
		if (!deviceAliases) {
			return ds;
		}

		if (deviceAliases.indexOf('=') >= 0) {
			var js = deviceAliases.split(',');
			for (var i = 0; i < js.length; i++) {
				var j = js[i].split('=');
				if (j.length === 2) {
					ds[j[0].trim()] = j[1].trim();
				}
			}

			debug("DeviceAliases=", ds);
			return ds;
		}

		deviceAliases.split(",").forEach((path) => {
			XplAPI._loadDeviceAliasesFile(path, ds, configuration);
		});

		debug("loadDeviceAliases", "DeviceAliases=", deviceAliases, "=>", ds);

		return ds;
	}
}

module.exports = XplAPI;
