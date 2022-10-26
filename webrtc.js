let serverConnection;
let localVideo, remoteVideo;
let localPeerConnection = null, remotePeerConnection = null;
let localQueue = new Array(), remoteQueue = new Array();
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
		}, 5000, this);
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
			localStart();
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
	if (remotePeerConnection !== null) {
		remotePeerConnection.close();
		remotePeerConnection = null;
	}
	localQueue = new Array();
	remoteQueue = new Array();
}

function localStart() {
	if (localPeerConnection !== null) {
		localPeerConnection.close();
	}
	// Local接続の開始
	localPeerConnection = new RTCPeerConnection(peerConnectionConfig);
	localPeerConnection.onicecandidate = gotIceCandidateLocal;
	if (window.stream) {
		window.stream.getTracks().forEach(track => localPeerConnection.addTrack(track, window.stream));
	}
	localPeerConnection.createOffer().then(createdDescription).catch(errorHandler);
}

function remoteStart() {
	if (remotePeerConnection !== null) {
		remotePeerConnection.close();
	}
	// Remote接続の開始
	remotePeerConnection = new RTCPeerConnection(peerConnectionConfig);
	remotePeerConnection.onicecandidate = gotIceCandidateRemote;
	remotePeerConnection.ontrack = gotRemoteStream;
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
		return;
	}
	if (signal.ping) {
		serverConnection.send(JSON.stringify({pong: 1}));
		return;
	}
	if (signal.re_offer) {
		if (localPeerConnection) {
			// 再オファー
			localPeerConnection.createOffer({iceRestart: true}).then(createdDescription).catch(errorHandler);
		}
		return;
	}
	if (signal.sdp) {
		if (signal.sdp.type === 'offer') {
			// Remote接続の開始
			remoteStart();
			remotePeerConnection.setRemoteDescription(signal.sdp).then(function() {
				remotePeerConnection.createAnswer().then(gotAnswer).catch(errorHandler);
			}).catch(errorHandler);
		} else if (signal.sdp.type === 'answer') {
			if (!localPeerConnection) {
				return;
			}
			localPeerConnection.setRemoteDescription(signal.sdp).catch(errorHandler);
			if (!remotePeerConnection || !remotePeerConnection.remoteDescription) {
				// Remote接続が開始していないので再オファーを要求
				serverConnection.send(JSON.stringify({re_offer: 1, remote: remoteId}));
			}
		}
	} else if (signal.ice_r) {
		if (remotePeerConnection && remotePeerConnection.remoteDescription) {
			remotePeerConnection.addIceCandidate(new RTCIceCandidate(signal.ice_r)).catch(errorHandler);
		} else {
			// Remote接続が開始していないのでRemoteキューに貯める
			remoteQueue.push(message);
			return;
		}
	} else if (signal.ice_l) {
		if (localPeerConnection && localPeerConnection.remoteDescription) {
			localPeerConnection.addIceCandidate(new RTCIceCandidate(signal.ice_l)).catch(errorHandler);
		} else {
			// Local接続が開始していないのでLocalキューに貯める
			localQueue.push(message);
			return;
		}
	}
	if (remoteQueue.length > 0 && remotePeerConnection && remotePeerConnection.remoteDescription) {
		// Remoteキューのメッセージを再処理
		gotMessageFromServer(remoteQueue.shift());
	}
	if (localQueue.length > 0 && localPeerConnection && localPeerConnection.remoteDescription) {
		// Localキューのメッセージを再処理
		gotMessageFromServer(localQueue.shift());
	}
}

function gotIceCandidateLocal(event) {
	if (event.candidate != null) {
		serverConnection.send(JSON.stringify({ice_r: event.candidate, remote: remoteId}));
	}
}

function gotIceCandidateRemote(event) {
	if (event.candidate != null) {
		serverConnection.send(JSON.stringify({ice_l: event.candidate, remote: remoteId}));
	}
}

function createdDescription(description) {
	localPeerConnection.setLocalDescription(description).then(function() {
		serverConnection.send(JSON.stringify({sdp: localPeerConnection.localDescription, remote: remoteId}));
	}).catch(errorHandler);
}

function gotAnswer(description) {
	remotePeerConnection.setLocalDescription(description).then(function() {
		serverConnection.send(JSON.stringify({sdp: remotePeerConnection.localDescription, remote: remoteId}));
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
