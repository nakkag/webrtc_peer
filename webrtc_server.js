const path = require('path');
const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');

const sslPort = 8443;
const serverConfig = {
	// SSL証明書、環境に合わせてパスを変更する
	key: fs.readFileSync('privkey.pem'),
	cert: fs.readFileSync('fullchain.pem')
};

// 接続リスト
let connections = [];

// WebSocket処理
const socketProc = function(ws, req) {
	ws.pingTimer = setInterval(function() {
		if (ws.readyState === WebSocket.OPEN) {
			// 接続確認
			ws.send(JSON.stringify({ping: 1}));
		}
	}, 180000);

	ws.on('message', function(message) {
		const json = JSON.parse(message);
		if (json.open) {
			console.log('open: ' + ws._socket.remoteAddress + ': local=' + json.open.local + ', remote=' + json.open.remote);
			// 同一IDが存在するときは古い方を削除
			connections = connections.filter(function (data, i) {
				if (data.local === json.open.local && data.remote === json.open.remote) {
					return false;
				}
				return true;
			});
			// 接続情報を保存
			connections.push({local: json.open.local, remote: json.open.remote, ws: ws});
			ws.send(JSON.stringify({start: 1}));
			return;
		}
		if (json.error) {
			console.error('client_error: ' + ws._socket.remoteAddress + ': ' + json.error);
			return;
		}
		if (json.pong) {
			return;
		}
		if (json.ping) {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({pong: 1}));
			}
			return;
		}
		// 対向の接続を検索
		connections.some(function(data) {
			if (data.local === json.remote && data.ws.readyState === WebSocket.OPEN) {
				// シグナリングメッセージの転送
				data.ws.send(JSON.stringify(json));
				return true;
			}
		});
	});

	ws.on('close', function () {
		closeConnection(ws);
		console.log('close: ' + ws._socket.remoteAddress);
	});

	ws.on('error', function(error) {
		closeConnection(ws);
		console.error('error: ' + ws._socket.remoteAddress + ': ' + error);
	});

	function closeConnection(conn) {
		connections = connections.filter(function (data, i) {
			if (data.ws !== conn) {
				return true;
			}
			connections.some(function(remoteData) {
				if (remoteData.local === data.remote && remoteData.ws.readyState === WebSocket.OPEN) {
					// 対向に切断を通知
					remoteData.ws.send(JSON.stringify({close: 1}));
					return true;
				}
			});
			data.ws = null;
			return false;
		});
		if (conn.pingTimer) {
			clearInterval(conn.pingTimer);
			conn.pingTimer = null;
		}
	}
};

// 静的ファイル処理
const service = function(req, res) {
	const file = path.join(process.cwd(), req.url);
	fs.stat(file, (err, stat) => {
		if (err) {
			res.writeHead(404);
			res.end();
			return;
		}
		if (stat.isDirectory()) {
			service({url: `${req.url}/index.html`}, res);
		} else if (stat.isFile()) {
			const stream = fs.createReadStream(file);
			stream.pipe(res);
		}
	});
};

// HTTPSサーバの開始
const httpsCamServer = https.createServer(serverConfig, service);
httpsCamServer.listen(sslPort, '0.0.0.0');
// WebSocketの開始
const wss_cam = new WebSocket.Server({server: httpsCamServer});
wss_cam.on('connection', socketProc);
console.log('Server running.');
