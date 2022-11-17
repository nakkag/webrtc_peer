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

window.onload = function() {
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
		navigator.mediaDevices.getUserMedia(constraints).then(stream => {
			window.stream = stream;
			localVideo.srcObject = stream;
			startServerConnection(localId, remoteId);
		}).catch(e => {
			alert('Camera start error.\n\n' + e.name + ': ' + e.message);
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
		clearInterval(this._pingTimer);
		setTimeout(conn => {
			if (sc === conn) {
				// 一定時間経過後にサーバーへ再接続
				startServerConnection(localId, remoteId);
			}
		}, 5000, this);
	}
	sc._pingTimer = setInterval(() => {
		// 接続確認
		sc.send(JSON.stringify({ping: 1}));
	}, 30000);
}

function startPeerConnection(sdpType) {
	stopPeerConnection();
	queue = new Array();
	pc = new RTCPeerConnection(peerConnectionConfig);
	pc.onicecandidate = function(event) {
		if (event.candidate) {
			// ICE送信
			sc.send(JSON.stringify({ice: event.candidate, remote: remoteId}));
		}
	};
	if (window.stream) {
		// Local側のストリームを設定
		window.stream.getTracks().forEach(track => pc.addTrack(track, window.stream));
	}
	pc.ontrack = function(event) {
		// Remote側のストリームを設定
		if (event.streams && event.streams[0]) {
			remoteVideo.srcObject = event.streams[0];
		} else {
			remoteVideo.srcObject = new MediaStream(event.track);
		}
	};
	if (sdpType === 'offer') {
		// Offerの作成
		pc.createOffer().then(setDescription).catch(errorHandler);
	}
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
		// サーバーからの「start」を受けてPeer接続を開始する
		startPeerConnection(signal.start);
		return;
	}
	if (signal.close) {
		// 接続先の終了通知
		stopVideo();
		stopPeerConnection();
		return;
	}
	if (signal.ping) {
		sc.send(JSON.stringify({pong: 1}));
		return;
	}
	if (!pc) {
		return;
	}
	// 以降はWebRTCのシグナリング処理
	if (signal.sdp) {
		// SDP受信
		if (signal.sdp.type === 'offer') {
			pc.setRemoteDescription(signal.sdp).then(() => {
				// Answerの作成
				pc.createAnswer().then(setDescription).catch(errorHandler);
			}).catch(errorHandler);
		} else if (signal.sdp.type === 'answer') {
			pc.setRemoteDescription(signal.sdp).catch(errorHandler);
		}
	}
	if (signal.ice) {
		// ICE受信
		if (pc.remoteDescription) {
			pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
		} else {
			// SDPが未処理のためキューに貯める
			queue.push(message);
			return;
		}
	}
	if (queue.length > 0 && pc.remoteDescription) {
		// キューのメッセージを再処理
		gotMessageFromServer(queue.shift());
	}
}

function setDescription(description) {
	pc.setLocalDescription(description).then(() => {
		// SDP送信
		sc.send(JSON.stringify({sdp: pc.localDescription, remote: remoteId}));
	}).catch(errorHandler);
}

function errorHandler(error) {
	alert('Signaling error.\n\n' + error.name + ': ' + error.message);
}
