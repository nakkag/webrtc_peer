let serverConnection;
let localVideo, remoteVideo;
let pc = null;
let queue = new Array();
let localId, remoteId;

const sslPort = 8443;
const peerConnectionConfig = {
	iceServers: [
		// GoogleのパブリックSTUNサーバーを指定しているが自前のSTUNサーバーがあれば変更する
		{urls: 'stun:stun.l.google.com:19302'},
		{urls: 'stun:stun1.l.google.com:19302'},
		{urls: 'stun:stun2.l.google.com:19302'},
		// TURNサーバーがあれば指定する
		//{urls: 'turn:turn_server', username:'', credential:''}
	]
};

document.onreadystatechange = function() {
	// Local IDとRemote IDを入力する
	// Local IDとRemote IDは別々の値を入力する
	// Remote IDと対向のLocal IDが一致するとカメラ接続が開始する
	while (!localId) {
		localId = window.prompt('Local ID', '');
	}
	while (!remoteId) {
		remoteId = window.prompt('Remote ID', '');
	}
	startWebRTC(localId, remoteId);
}

function startWebRTC(localId, remoteId) {
	localVideo = document.getElementById('localVideo');
	if (localVideo) {
		localVideo.srcObject = null;
	}
	remoteVideo = document.getElementById('remoteVideo');
	stopVideo();

	if (serverConnection) {
		serverConnection.close();
	}
	// サーバー接続の開始
	serverConnection = new WebSocket('wss://' + location.hostname + ':' + sslPort + '/');
	serverConnection.onmessage = gotMessageFromServer;
	serverConnection.onopen = function(event) {
		// サーバーに接続情報を通知
		this.send(JSON.stringify({open: {local: localId, remote: remoteId}}));
	};
	serverConnection.onclose = function(event) {
		clearInterval(this.timer);
		setTimeout(function(conn) {
			if (serverConnection === conn) {
				// 一定時間経過後にサーバーへ再接続
				startWebRTC(localId, remoteId);
			}
		}, Math.floor(Math.random() * 4000) + 1000, this);
	}
	serverConnection.timer = setInterval(function() {
		// 接続確認
		serverConnection.send(JSON.stringify({ping: 1}));
	}, 30000);
}

function startVideo() {
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
			startPeer();
		}).catch(e => {
			console.error(error);
			alert('WebCam Start Error.\n\n' + error);
		});
	} else {
		alert('Your browser does not support getUserMedia API');
	}
}

function stopVideo() {
	if (remoteVideo && remoteVideo.srcObject) {
		try {
			remoteVideo.srcObject.getTracks().forEach(track => {
				track.stop();
			});
		} catch(error) {
			console.error(error);
		}
		remoteVideo.srcObject = null;
	}
	if (pc !== null) {
		pc.close();
		pc = null;
	}
	queue = new Array();
}

function startPeer() {
	if (pc !== null) {
		pc.close();
	}
	pc = new RTCPeerConnection(peerConnectionConfig);
	pc.onicecandidate = gotIceCandidate;
	if (window.stream) {
		window.stream.getTracks().forEach(track => pc.addTrack(track, window.stream));
	}
	pc.createOffer().then(createdDescription).catch(errorHandler);
	pc.ontrack = gotRemoteStream;
}

function gotMessageFromServer(message) {
	const signal = JSON.parse(message.data);
	if (signal.start) {
		// サーバーからの「start」を受けてビデオを開始する
		startVideo();
		return;
	}
	if (signal.close) {
		// 接続先の終了通知
		stopVideo();
		startPeer();
		return;
	}
	if (signal.ping) {
		serverConnection.send(JSON.stringify({pong: 1}));
		return;
	}
	if (signal.sdp) {
		if (signal.sdp.type === 'offer') {
			if (pc.remoteDescription) {
				// Peer接続済のため今のPeerを破棄して、新しいPeerを開始する
				stopVideo();
				startPeer();
				return;
			}
			pc.setRemoteDescription(signal.sdp).then(function() {
				pc.createAnswer().then(gotAnswer).catch(errorHandler);
			}).catch(errorHandler);
		} else if (signal.sdp.type === 'answer') {
			if (!pc) {
				return;
			}
			pc.setRemoteDescription(signal.sdp).catch(errorHandler);
		}
	} else if (signal.ice) {
		if (pc && pc.remoteDescription) {
			pc.addIceCandidate(new RTCIceCandidate(signal.ice)).catch(errorHandler);
		} else {
			// Peer接続が完了していないのでキューに貯める
			queue.push(message);
			return;
		}
	}
	if (queue.length > 0 && pc && pc.remoteDescription) {
		// キューのメッセージを再処理
		gotMessageFromServer(queue.shift());
	}
}

function gotIceCandidate(event) {
	if (event.candidate != null) {
		serverConnection.send(JSON.stringify({ice: event.candidate, remote: remoteId}));
	}
}

function createdDescription(description) {
	pc.setLocalDescription(description).then(function() {
		serverConnection.send(JSON.stringify({sdp: pc.localDescription, remote: remoteId}));
	}).catch(errorHandler);
}

function gotAnswer(description) {
	pc.setLocalDescription(description).then(function() {
		serverConnection.send(JSON.stringify({sdp: pc.localDescription, remote: remoteId}));
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
