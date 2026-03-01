package com.deltaapp.deltacore

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import uniffi.delta_core.BootstrapNode
import uniffi.delta_core.OnionHopFfi
import uniffi.delta_core.OrgSummary

@ReactModule(name = "DeltaCore")
class DeltaCoreModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    @JvmStatic
    fun ensureLoaded() {
      try {
        System.loadLibrary("delta_core")
        android.util.Log.d("DeltaCore", "Loaded delta_core library")
      } catch (t: Throwable) {
        android.util.Log.e("DeltaCore", "Failed to load delta_core library", t)
        throw RuntimeException("Failed to load delta_core library", t)
      }
      try {
        // Ensure UniFFI scaffolding is initialized (class init runs integrity checks)
        uniffi.delta_core.uniffiEnsureInitialized()
        android.util.Log.d("DeltaCore", "UniFFI initialized successfully")
      } catch (t: Throwable) {
        android.util.Log.e("DeltaCore", "Failed to initialize UniFFI", t)
        throw RuntimeException("Failed to initialize UniFFI: " + t.message, t)
      }
    }
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  override fun getName(): String = "DeltaCore"

  override fun getConstants(): Map<String, Any> = mapOf(
    "dbDir" to reactContext.filesDir.absolutePath,
  )

  // ── Phase 1 ─────────────────────────────────────────────────────────────────

  @ReactMethod
  fun generateKeypair(promise: Promise) {
    ensureLoaded()
    try {
      val kp = uniffi.delta_core.generateKeypair()
      val map = Arguments.createMap()
      map.putString("privateKeyHex", kp.privateKeyHex)
      map.putString("publicKeyHex", kp.publicKeyHex)
      map.putString("mnemonic", kp.mnemonic)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("KeyError", e)
    }
  }

  @ReactMethod
  fun importFromMnemonic(words: ReadableArray, promise: Promise) {
    ensureLoaded()
    try {
      val list = (0 until words.size()).map { words.getString(it)!! }
      val kp = uniffi.delta_core.importFromMnemonic(list)
      val map = Arguments.createMap()
      map.putString("privateKeyHex", kp.privateKeyHex)
      map.putString("publicKeyHex", kp.publicKeyHex)
      map.putString("mnemonic", kp.mnemonic)
      promise.resolve(map)
    } catch (e: Exception) {
      promise.reject("KeyError", e)
    }
  }

  // ── Phase 3 / Core init ─────────────────────────────────────────────────────

  @ReactMethod
  fun initCore(privateKeyHex: String, dbDir: String, bootstrap: ReadableArray, promise: Promise) {
    ensureLoaded()
    val nodes = (0 until bootstrap.size()).map { idx ->
      val m = bootstrap.getMap(idx)!!
      BootstrapNode(
        nodeIdHex = m.getString("nodeIdHex")!!,
        relayUrl = m.getString("relayUrl")!!,
      )
    }
    val resolvedDbDir = reactContext.filesDir.also { it.mkdirs() }.absolutePath
    scope.launch {
      try {
        uniffi.delta_core.initCore(privateKeyHex, resolvedDbDir, nodes)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Networking / status ─────────────────────────────────────────────────────

  @ReactMethod
  fun getConnectionStatus(promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val status = uniffi.delta_core.getConnectionStatus()
        // Map to TS expected strings: 'Online' | 'Connecting' | 'Offline'
        val js = when (status) {
          uniffi.delta_core.ConnectionStatus.ONLINE -> "Online"
          uniffi.delta_core.ConnectionStatus.CONNECTING -> "Connecting"
          uniffi.delta_core.ConnectionStatus.OFFLINE -> "Offline"
        }
        promise.resolve(js)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Stubs for remaining APIs — implement incrementally ──────────────────────

  @ReactMethod
  fun createOrUpdateProfile(username: String, bio: String?, availableFor: ReadableArray, isPublic: Boolean, promise: Promise) {
    ensureLoaded()
    val list = (0 until availableFor.size()).map { availableFor.getString(it)!! }
    scope.launch {
      try {
        uniffi.delta_core.createOrUpdateProfile(username, bio, list, isPublic)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun getMyProfile(promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val p = uniffi.delta_core.getMyProfile()
        if (p == null) { promise.resolve(null); return@launch }
        val map = Arguments.createMap()
        map.putString("publicKey", p.publicKey)
        map.putString("username", p.username)
        map.putString("avatarBlobId", p.avatarBlobId)
        map.putString("bio", p.bio)
        val arr = Arguments.createArray()
        p.availableFor.forEach { arr.pushString(it) }
        map.putArray("availableFor", arr)
        map.putBoolean("isPublic", p.isPublic)
        map.putDouble("createdAt", p.createdAt.toDouble())
        map.putDouble("updatedAt", p.updatedAt.toDouble())
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun getProfile(publicKey: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val p = uniffi.delta_core.getProfile(publicKey)
        if (p == null) { promise.resolve(null); return@launch }
        val map = Arguments.createMap()
        map.putString("publicKey", p.publicKey)
        map.putString("username", p.username)
        map.putString("avatarBlobId", p.avatarBlobId)
        map.putString("bio", p.bio)
        val arr = Arguments.createArray()
        p.availableFor.forEach { arr.pushString(it) }
        map.putArray("availableFor", arr)
        map.putBoolean("isPublic", p.isPublic)
        map.putDouble("createdAt", p.createdAt.toDouble())
        map.putDouble("updatedAt", p.updatedAt.toDouble())
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Pkarr ────────────────────────────────────────────────────────────────────

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getPkarrUrl(publicKeyHex: String): String {
    ensureLoaded()
    return uniffi.delta_core.getPkarrUrl(publicKeyHex)
  }

  @ReactMethod
  fun resolvePkarr(z32Key: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val resolved = uniffi.delta_core.resolvePkarr(z32Key)
        if (resolved == null) {
          promise.resolve(null)
          return@launch
        }
        val map = Arguments.createMap()
        map.putString("recordType", resolved.recordType)
        map.putString("name", resolved.name)
        map.putString("username", resolved.username)
        map.putString("description", resolved.description)
        map.putString("bio", resolved.bio)
        map.putString("avatarBlobId", resolved.avatarBlobId)
        map.putString("coverBlobId", resolved.coverBlobId)
        map.putString("publicKey", resolved.publicKey)
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Orgs ─────────────────────────────────────────────────────────────────────

  @ReactMethod
  fun createOrg(name: String, typeLabel: String, description: String?, isPublic: Boolean, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val orgId = uniffi.delta_core.createOrg(name, typeLabel, description, isPublic)
        promise.resolve(orgId)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun listMyOrgs(promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val orgs = uniffi.delta_core.listMyOrgs()
        promise.resolve(orgsToWritableArray(orgs))
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun updateOrg(
    orgId: String,
    name: String?,
    typeLabel: String?,
    description: String?,
    avatarBlobId: String?,
    coverBlobId: String?,
    isPublic: Boolean?,
    promise: Promise,
  ) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.delta_core.updateOrg(orgId, name, typeLabel, description, avatarBlobId, coverBlobId, isPublic)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun searchPublicOrgs(query: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val orgs = uniffi.delta_core.searchPublicOrgs(query)
        promise.resolve(orgsToWritableArray(orgs))
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Rooms ─────────────────────────────────────────────────────────────────────

  @ReactMethod
  fun createRoom(orgId: String, name: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val roomId = uniffi.delta_core.createRoom(orgId, name)
        promise.resolve(roomId)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun listRooms(orgId: String, includeArchived: Boolean, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val rooms = uniffi.delta_core.listRooms(orgId, includeArchived)
        val arr = Arguments.createArray()
        for (r in rooms) {
          val map = Arguments.createMap()
          map.putString("roomId", r.roomId)
          map.putString("orgId", r.orgId)
          map.putString("name", r.name)
          map.putString("createdBy", r.createdBy)
          map.putDouble("createdAt", r.createdAt.toDouble())
          map.putDouble("encKeyEpoch", r.encKeyEpoch.toDouble())
          map.putBoolean("isArchived", r.isArchived)
          r.archivedAt?.let { map.putDouble("archivedAt", it.toDouble()) } ?: map.putNull("archivedAt")
          arr.pushMap(map)
        }
        promise.resolve(arr)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun updateRoom(orgId: String, roomId: String, name: String?, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.delta_core.updateRoom(orgId, roomId, name)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun deleteRoom(orgId: String, roomId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.delta_core.deleteRoom(orgId, roomId)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun archiveRoom(orgId: String, roomId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.delta_core.archiveRoom(orgId, roomId)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun unarchiveRoom(orgId: String, roomId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.delta_core.unarchiveRoom(orgId, roomId)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Messages ──────────────────────────────────────────────────────────────────

  @ReactMethod
  fun sendMessage(
    roomId: String?,
    dmThreadId: String?,
    contentType: String,
    textContent: String?,
    blobId: String?,
    embedUrl: String?,
    mentions: ReadableArray,
    replyTo: String?,
    promise: Promise,
  ) {
    ensureLoaded()
    val mentionsList = (0 until mentions.size()).map { mentions.getString(it)!! }
    scope.launch {
      try {
        val messageId = uniffi.delta_core.sendMessage(
          roomId, dmThreadId, contentType, textContent, blobId, embedUrl, mentionsList, replyTo
        )
        promise.resolve(messageId)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun listMessages(
    roomId: String?,
    dmThreadId: String?,
    limit: Int,
    beforeTimestamp: Double?,
    promise: Promise,
  ) {
    ensureLoaded()
    scope.launch {
      try {
        val beforeTs: Long? = beforeTimestamp?.toLong()
        val messages = uniffi.delta_core.listMessages(roomId, dmThreadId, limit.toUInt(), beforeTs)
        val arr = Arguments.createArray()
        for (m in messages) {
          val map = Arguments.createMap()
          map.putString("messageId", m.messageId)
          m.roomId?.let { map.putString("roomId", it) } ?: map.putNull("roomId")
          m.dmThreadId?.let { map.putString("dmThreadId", it) } ?: map.putNull("dmThreadId")
          map.putString("authorKey", m.authorKey)
          map.putString("contentType", m.contentType)
          m.textContent?.let { map.putString("textContent", it) } ?: map.putNull("textContent")
          m.blobId?.let { map.putString("blobId", it) } ?: map.putNull("blobId")
          m.embedUrl?.let { map.putString("embedUrl", it) } ?: map.putNull("embedUrl")
          val mentionsArr = Arguments.createArray()
          m.mentions.forEach { mentionsArr.pushString(it) }
          map.putArray("mentions", mentionsArr)
          m.replyTo?.let { map.putString("replyTo", it) } ?: map.putNull("replyTo")
          map.putDouble("timestamp", m.timestamp.toDouble())
          m.editedAt?.let { map.putDouble("editedAt", it.toDouble()) } ?: map.putNull("editedAt")
          map.putBoolean("isDeleted", m.isDeleted)
          arr.pushMap(map)
        }
        promise.resolve(arr)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── DM threads ────────────────────────────────────────────────────────────────

  @ReactMethod
  fun createDmThread(recipientKey: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val threadId = uniffi.delta_core.createDmThread(recipientKey)
        promise.resolve(threadId)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun listDmThreads(promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val threads = uniffi.delta_core.listDmThreads()
        val arr = Arguments.createArray()
        for (t in threads) {
          val map = Arguments.createMap()
          map.putString("threadId", t.threadId)
          map.putString("initiatorKey", t.initiatorKey)
          map.putString("recipientKey", t.recipientKey)
          map.putDouble("createdAt", t.createdAt.toDouble())
          t.lastMessageAt?.let { map.putDouble("lastMessageAt", it.toDouble()) } ?: map.putNull("lastMessageAt")
          arr.pushMap(map)
        }
        promise.resolve(arr)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────────

  @ReactMethod
  fun subscribeRoomTopic(roomId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.delta_core.subscribeRoomTopic(roomId)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun subscribeDmTopic(threadId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.delta_core.subscribeDmTopic(threadId)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Members ───────────────────────────────────────────────────────────────────

  @ReactMethod
  fun addMemberDirect(orgId: String, memberPublicKey: String, accessLevel: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.delta_core.addMemberDirect(orgId, memberPublicKey, accessLevel)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("AuthError", e)
      }
    }
  }

  @ReactMethod
  fun removeMemberFromOrg(orgId: String, memberPublicKey: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.delta_core.removeMemberFromOrg(orgId, memberPublicKey)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("AuthError", e)
      }
    }
  }

  @ReactMethod
  fun changeMemberPermission(orgId: String, memberPublicKey: String, newAccessLevel: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.delta_core.changeMemberPermission(orgId, memberPublicKey, newAccessLevel)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("AuthError", e)
      }
    }
  }

  @ReactMethod
  fun listOrgMembers(orgId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val members = uniffi.delta_core.listOrgMembers(orgId)
        val arr = Arguments.createArray()
        for (m in members) {
          val map = Arguments.createMap()
          map.putString("publicKey", m.publicKey)
          map.putString("accessLevel", m.accessLevel)
          map.putDouble("joinedAt", m.joinedAt.toDouble())
          arr.pushMap(map)
        }
        promise.resolve(arr)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Invite tokens (synchronous) ───────────────────────────────────────────────

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun generateInviteToken(orgId: String, accessLevel: String, expiryTimestamp: Double): String {
    ensureLoaded()
    return uniffi.delta_core.generateInviteToken(orgId, accessLevel, expiryTimestamp.toLong())
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun verifyInviteToken(tokenBase64: String, currentTimestamp: Double): WritableMap {
    ensureLoaded()
    val info = uniffi.delta_core.verifyInviteToken(tokenBase64, currentTimestamp.toLong())
    val map = Arguments.createMap()
    map.putString("orgId", info.orgId)
    map.putString("inviterKey", info.inviterKey)
    map.putString("accessLevel", info.accessLevel)
    map.putDouble("expiryTimestamp", info.expiryTimestamp.toDouble())
    return map
  }

  // ── Blobs (data passed as base64 string over the bridge) ──────────────────────

  @ReactMethod
  fun uploadBlob(dataBase64: String, mimeType: String, roomId: String?, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val bytes = Base64.decode(dataBase64, Base64.DEFAULT)
        val blobId = uniffi.delta_core.uploadBlob(bytes, mimeType, roomId)
        promise.resolve(blobId)
      } catch (e: Exception) {
        promise.reject("BlobError", e)
      }
    }
  }

  @ReactMethod
  fun getBlob(blobHash: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val bytes = uniffi.delta_core.getBlob(blobHash)
        val base64 = Base64.encodeToString(bytes, Base64.DEFAULT)
        promise.resolve(base64)
      } catch (e: Exception) {
        promise.reject("BlobError", e)
      }
    }
  }

  // ── Onion routing (bytes as base64 over the bridge) ───────────────────────

  @ReactMethod
  fun buildOnionPacket(
    hopsArray: ReadableArray,
    topicIdBase64: String,
    opBase64: String,
    promise: Promise,
  ) {
    ensureLoaded()
    scope.launch {
      try {
        val hops = (0 until hopsArray.size()).map { i ->
          val map = hopsArray.getMap(i)!!
          OnionHopFfi(
            pubkeyHex = map.getString("pubkeyHex")!!,
            nextUrl   = map.getString("nextUrl")!!,
          )
        }
        val topicIdBytes = Base64.decode(topicIdBase64, Base64.DEFAULT)
        val opBytes      = Base64.decode(opBase64, Base64.DEFAULT)
        val packet       = uniffi.delta_core.buildOnionPacket(hops, topicIdBytes, opBytes)
        promise.resolve(Base64.encodeToString(packet, Base64.DEFAULT))
      } catch (e: Exception) {
        promise.reject("OnionError", e)
      }
    }
  }

  @ReactMethod
  fun peelOnionLayer(packetBase64: String, recipientSeedHex: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val packet = Base64.decode(packetBase64, Base64.DEFAULT)
        val peeled = uniffi.delta_core.peelOnionLayer(packet, recipientSeedHex)
        val map = Arguments.createMap()
        map.putString("peelType", peeled.peelType)
        peeled.nextHopUrl?.let { map.putString("nextHopUrl", it) }
          ?: map.putNull("nextHopUrl")
        peeled.innerPacket?.let {
          map.putString("innerPacketBase64", Base64.encodeToString(it, Base64.DEFAULT))
        } ?: map.putNull("innerPacketBase64")
        peeled.topicId?.let {
          map.putString("topicIdBase64", Base64.encodeToString(it, Base64.DEFAULT))
        } ?: map.putNull("topicIdBase64")
        peeled.op?.let {
          map.putString("opBase64", Base64.encodeToString(it, Base64.DEFAULT))
        } ?: map.putNull("opBase64")
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("OnionError", e)
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private fun orgsToWritableArray(orgs: List<OrgSummary>) = Arguments.createArray().also { arr ->
    for (o in orgs) {
      val map = Arguments.createMap()
      map.putString("orgId", o.orgId)
      map.putString("name", o.name)
      map.putString("typeLabel", o.typeLabel)
      o.description?.let { map.putString("description", it) } ?: map.putNull("description")
      o.avatarBlobId?.let { map.putString("avatarBlobId", it) } ?: map.putNull("avatarBlobId")
      o.coverBlobId?.let { map.putString("coverBlobId", it) } ?: map.putNull("coverBlobId")
      map.putBoolean("isPublic", o.isPublic)
      map.putString("creatorKey", o.creatorKey)
      map.putDouble("createdAt", o.createdAt.toDouble())
      arr.pushMap(map)
    }
  }
}
