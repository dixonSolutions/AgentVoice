import Foundation
import CallKit
import AVFoundation
import Capacitor
import PushKit

/// Manages outbound CallKit calls and VoIP push → incoming call for agent approvals.
@objc public class CallKitManager: NSObject, CXProviderDelegate, PKPushRegistryDelegate {
    public static let shared = CallKitManager()

    private var provider: CXProvider?
    private var callController = CXCallController()
    private var activeCallUUID: UUID?
    private var voipRegistry: PKPushRegistry?
    private weak var plugin: CallSessionPlugin?

    private override init() {
        super.init()
        configureProvider()
        configureVoipPush()
    }

    func attach(plugin: CallSessionPlugin) {
        self.plugin = plugin
    }

    private func configureProvider() {
        let config = CXProviderConfiguration(localizedName: "AgentVoice")
        config.supportsVideo = false
        config.maximumCallsPerCallGroup = 1
        config.maximumCallGroups = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        provider = CXProvider(configuration: config)
        provider?.setDelegate(self, queue: nil)
    }

    private func configureVoipPush() {
        voipRegistry = PKPushRegistry(queue: DispatchQueue.main)
        voipRegistry?.delegate = self
        voipRegistry?.desiredPushTypes = [.voIP]
    }

    public func startOutboundCall() {
        let uuid = UUID()
        activeCallUUID = uuid
        let handle = CXHandle(type: .generic, value: "AgentVoice")
        let start = CXStartCallAction(call: uuid, handle: handle)
        start.isVideo = false
        let transaction = CXTransaction(action: start)
        callController.request(transaction) { error in
            if let error = error {
                NSLog("CallKit start failed: \(error.localizedDescription)")
            }
        }
    }

    public func endActiveCall() {
        guard let uuid = activeCallUUID else { return }
        let end = CXEndCallAction(call: uuid)
        let transaction = CXTransaction(action: end)
        callController.request(transaction) { _ in }
        activeCallUUID = nil
    }

    public func isCallActive() -> Bool {
        return activeCallUUID != nil
    }

    public func reportIncomingApprovalCall(title: String, body: String) {
        let uuid = UUID()
        activeCallUUID = uuid
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: "AgentVoice")
        update.localizedCallerName = title
        update.hasVideo = false
        provider?.reportNewIncomingCall(with: uuid, update: update) { error in
            if let error = error {
                NSLog("Incoming call report failed: \(error.localizedDescription)")
            }
        }
    }

    public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
        provider.reportOutgoingCall(with: action.callUUID, connectedAt: Date())
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if activeCallUUID == action.callUUID {
            activeCallUUID = nil
        }
        plugin?.notifyCallEnded()
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        action.fulfill()
        plugin?.notifyIncomingCallAnswered()
    }

    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        do {
            try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .duckOthers])
            // Larger IO buffers = fewer CPU wakeups. Wake-word spotting does not need 5 ms VoIP latency.
            try audioSession.setPreferredIOBufferDuration(0.02)
            try audioSession.setActive(true)
        } catch {
            NSLog("Audio session setup failed: \(error.localizedDescription)")
        }
        plugin?.notifyAudioSessionActivated()
    }

    public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        plugin?.notifyAudioSessionDeactivated()
    }

    public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        plugin?.notifyVoipToken(token)
    }

    public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let data = payload.dictionaryPayload
        let title = (data["title"] as? String) ?? "AgentVoice"
        let body = (data["body"] as? String) ?? "Agent needs your input"
        reportIncomingApprovalCall(title: title, body: body)
        completion()
    }
}
