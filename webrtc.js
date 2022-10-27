let localVideo, remoteVideo;
let localId, remoteId;
let sc, pc, queue;

const sslPort = 8443;
const peerConnectionConfig = {
	iceServers: [
		// GoogleのパブリックSTUNサーバーを指定しているが自前のSTUNサーバーに変更可
		{urls: 'stun:stun.l.google.com:19302'},
		{urls: 'stun:stun1.l.google.com:19302'},
		{urls: 'stun:stun2.l.google.com:19302'},
		// TURNサーバーがあれば指定する
		//{urls: 'turn:turn_server', username:'', credential:''}
	]
};

document.onreadystatechange = function() {
	localVideo = document.getElementById('localVideo');
	remoteVideo = document.getElementById('remoteVideo');

	// Local IDとRemote IDは別々の値を入力する
	// Remote IDと対向のLocal IDが一致するとビデオ通話を開始する
	while (!localId) {
		localId = window.prompt('Local ID', '');
	}
	while (!remoteId) {
		remoteId = window.prompt('Remote ID', '');
	}
	startVideo(localId, remoteId);
}

function startVideo(localId, remoteId) {
	if (navigator.mediaDevices.getUserMedia) {
		if (window.stream) {
			// 既存のストリームを破棄
			try {
				window.stream.getTracks().forEach(track => {
					track.stop();
				});
			} catch(error) {
				console.error(error);
			}
			window.stream = null;
		}
		// カメラとマイクの開始
		const constraints = {
			audio: true,
			video: true
		};
		navigator.mediaDevices.getUserMedia(constraints).then(function(stream) {
			window.stream = stream;
			localVideo.srcObject = stream;
			startServerConnection(localId, remoteId);
		}).catch(e => {
			console.error(error);
			alert('WebCam Start Error.\n\n' + error);
		});
	} else {
		alert('Your browser does not support getUserMedia API');
	}
}

function stopVideo() {
	if (remoteVideo.srcObject) {
		try {
			remoteVideo.srcObject.getTracks().forEach(track => {
				track.stop();
			});
		} catch(error) {
			console.error(error);
		}
		remoteVideo.srcObject = null;
	}
}

function startServerConnection(localId, remoteId) {
	if (sc) {
		sc.close();
	}
	// サーバー接続の開始
	sc = new WebSocket('wss://' + location.hostname + ':' + sslPort + '/');
	sc.onmessage = gotMessageFromServer;
	sc.onopen = function(event) {
		// サーバーに接続情報を通知
		this.send(JSON.stringify({open: {local: localId, remote: remoteId}}));
	};
	sc.onclose = function(event) {
		clearInterval(this.timer);
		setTimeout(function(conn) {
			if (sc === conn) {
				// 一定時間経過後にサーバーへ再接続
				startServerConnection(localId, remoteId);
			}
		}, 5000, this);
	}
	sc.timer = setInterval(function() {
		// 接続確認
		sc.send(JSON.stringify({ping: 1}));
	}, 30000);
}

function startPeerConnection() {
	stopPeerConnection();
	queue = new Array();
	pc = new RTCPeerConnection(peerConnectionConfig);
	pc.onicecandidate = gotIceCandidate;
	if (window.stream) {
		window.stream.getTracks().forEach(track => pc.addTrack(track, window.stream));
	}
	pc.ontrack = gotRemoteStream;
	pc.createOffer().then(createdDescription).catch(errorHandler);
}

function stopPeerConnection() {
	if (pc) {
		pc.close();
		pc = null;
	}
}

function gotMessageFromServer(message) {
	const signal = JSON.parse(message.data);
	if (signal.start) {
		startPeerConnection();
		return;
	}
	if (signal.close) {
		// 接続先の終了通知
		stopVideo();
		return;
	}
	if (signal.ping) {
		sc.send(JSON.stringify({pong: 1}));
		return;
	}
	if (!pc) {
		return;
	}
	if (signal.sdp) {
		if (pc.remoteDescription) {
			// 接続済で新しい接続が来た場合は古い方を破棄する
			stopPeerConnection();
			// 同時接続回避のための遅延
			setTimeout(function() {
				startPeerConnection();
			}, Math.floor(Math.random() * 1000));
			return;
		}
		if (signal.sdp.type === 'offer') {
			pc.setRemoteDescription(signal.sdp).then(function() {
				pc.createAnswer().then(gotAnswer).catch(errorHandler);
			}).catch(errorHandler);
		} else if (signal.sdp.type === 'answer') {
			pc.setRemoteDescription(signal.sdp).catch(errorHandler);
		}
	} else if (signal.ice) {
		if (pc.remoteDescription) {
			pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
		} else {
			// Peer接続が完了していないのでキューに貯める
			queue.push(message);
			return;
		}
	}
	if (queue.length > 0 && pc.remoteDescription) {
		// キューのメッセージを再処理
		gotMessageFromServer(queue.shift());
	}
}

function gotIceCandidate(event) {
	if (event.candidate) {
		sc.send(JSON.stringify({ice: event.candidate, remote: remoteId}));
	}
}

function createdDescription(description) {
	pc.setLocalDescription(description).then(function() {
		sc.send(JSON.stringify({sdp: pc.localDescription, remote: remoteId}));
	}).catch(errorHandler);
}

function gotAnswer(description) {
	pc.setLocalDescription(description).then(function() {
		sc.send(JSON.stringify({sdp: pc.localDescription, remote: remoteId}));
	}).catch(errorHandler);
}

function gotRemoteStream(event) {
	if (event.streams && event.streams[0]) {
		remoteVideo.srcObject = event.streams[0];
	} else {
		remoteVideo.srcObject = new MediaStream(event.track);
	}
}

function errorHandler(error) {
	alert('WebCam Start Error.\n\n' + error);
}
