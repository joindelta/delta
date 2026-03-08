package com.gardensapp.gardenscore

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
import uniffi.gardens_core.Event
import uniffi.gardens_core.EventRsvp
import uniffi.gardens_core.OnionHopFfi
import uniffi.gardens_core.OrgSummary
import uniffi.gardens_core.SyncHopFfi

@ReactModule(name = "GardensCore")
class GardensCoreModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

  companion object {
    @JvmStatic
    fun ensureLoaded() {
      try {
        System.loadLibrary("gardens_core")
        android.util.Log.d("GardensCore", "Loaded gardens_core library")
      } catch (t: Throwable) {
        android.util.Log.e("GardensCore", "Failed to load gardens_core library", t)
        throw RuntimeException("Failed to load gardens_core library", t)
      }
      try {
        // Ensure UniFFI scaffolding is initialized (class init runs integrity checks)
        uniffi.gardens_core.uniffiEnsureInitialized()
        android.util.Log.d("GardensCore", "UniFFI initialized successfully")
      } catch (t: Throwable) {
        android.util.Log.e("GardensCore", "Failed to initialize UniFFI", t)
        throw RuntimeException("Failed to initialize UniFFI: " + t.message, t)
      }
    }
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  override fun getName(): String = "GardensCore"

  override fun getConstants(): Map<String, Any> = mapOf(
    "dbDir" to reactContext.filesDir.absolutePath,
  )

  // ── Phase 1 ─────────────────────────────────────────────────────────────────

  @ReactMethod
  fun generateKeypair(promise: Promise) {
    ensureLoaded()
    try {
      val kp = uniffi.gardens_core.generateKeypair()
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
      val kp = uniffi.gardens_core.importFromMnemonic(list)
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
  fun initCore(privateKeyHex: String, dbDir: String, promise: Promise) {
    ensureLoaded()
    val resolvedDbDir = reactContext.filesDir.also { it.mkdirs() }.absolutePath
    scope.launch {
      try {
        uniffi.gardens_core.initCore(privateKeyHex, resolvedDbDir)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Network / Iroh P2P ─────────────────────────────────────────────────────

  @ReactMethod
  fun initNetwork(relayUrl: String?, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val nodeId = uniffi.gardens_core.initNetwork(relayUrl)
        promise.resolve(nodeId)
      } catch (e: Exception) {
        promise.reject("NetworkError", e)
      }
    }
  }

  @ReactMethod
  fun isNetworkInitialized(promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val ok = uniffi.gardens_core.isNetworkInitialized()
        promise.resolve(ok)
      } catch (e: Exception) {
        promise.reject("NetworkError", e)
      }
    }
  }

  @ReactMethod
  fun getNodeId(promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val nodeId = uniffi.gardens_core.getNodeId()
        promise.resolve(nodeId)
      } catch (e: Exception) {
        promise.reject("NetworkError", e)
      }
    }
  }

  // ── Networking / status ─────────────────────────────────────────────────────

  @ReactMethod
  fun getConnectionStatus(promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val status = uniffi.gardens_core.getConnectionStatus()
        // Map to TS expected strings: 'Online' | 'Connecting' | 'Offline'
        val js = when (status) {
          uniffi.gardens_core.ConnectionStatus.ONLINE -> "Online"
          uniffi.gardens_core.ConnectionStatus.CONNECTING -> "Connecting"
          uniffi.gardens_core.ConnectionStatus.OFFLINE -> "Offline"
        }
        promise.resolve(js)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Stubs for remaining APIs — implement incrementally ──────────────────────

  @ReactMethod
  fun createOrUpdateProfile(username: String, bio: String?, availableFor: ReadableArray, isPublic: Boolean, avatarBlobId: String?, emailEnabled: Boolean, promise: Promise) {
    ensureLoaded()
    val list = (0 until availableFor.size()).map { availableFor.getString(it)!! }
    scope.launch {
      try {
        uniffi.gardens_core.createOrUpdateProfile(username, bio, list, isPublic, avatarBlobId, emailEnabled)
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
        val p = uniffi.gardens_core.getMyProfile()
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
        val p = uniffi.gardens_core.getProfile(publicKey)
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
    return uniffi.gardens_core.getPkarrUrl(publicKeyHex)
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun getPkarrUrlFromZ32(z32Key: String): String {
    ensureLoaded()
    return uniffi.gardens_core.getPkarrUrlFromZ32(z32Key)
  }

  @ReactMethod
  fun resolvePkarr(z32Key: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val resolved = uniffi.gardens_core.resolvePkarr(z32Key)
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
        val orgId = uniffi.gardens_core.createOrg(name, typeLabel, description, isPublic)
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
        val orgs = uniffi.gardens_core.listMyOrgs()
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
    welcomeText: String?,
    customEmojiJson: String?,
    orgCooldownSecs: Double?,
    isPublic: Boolean?,
    emailEnabled: Boolean?,
    promise: Promise,
  ) {
    ensureLoaded()
    scope.launch {
      try {
        android.util.Log.d("GardensCore", "updateOrg(orgId=$orgId, isPublic=$isPublic)")
        val orgCooldownSecsLong = orgCooldownSecs?.toLong()
        uniffi.gardens_core.updateOrg(
          orgId,
          name,
          typeLabel,
          description,
          avatarBlobId,
          coverBlobId,
          welcomeText,
          customEmojiJson,
          orgCooldownSecsLong,
          isPublic,
          emailEnabled,
        )
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
        val orgs = uniffi.gardens_core.searchPublicOrgs(query)
        promise.resolve(orgsToWritableArray(orgs))
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun setOrgCooldown(orgId: String, cooldownSecs: Double, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.gardens_core.setOrgCooldown(orgId, cooldownSecs.toLong())
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun deleteOrg(orgId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.gardens_core.deleteOrg(orgId)
        promise.resolve(null)
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
        val roomId = uniffi.gardens_core.createRoom(orgId, name)
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
        val rooms = uniffi.gardens_core.listRooms(orgId, includeArchived)
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
  fun updateRoom(orgId: String, roomId: String, name: String?, roomCooldownSecs: Double?, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val roomCooldownSecsLong = roomCooldownSecs?.toLong()
        uniffi.gardens_core.updateRoom(orgId, roomId, name, roomCooldownSecsLong)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun setRoomCooldown(orgId: String, roomId: String, cooldownSecs: Double, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.gardens_core.setRoomCooldown(orgId, roomId, cooldownSecs.toLong())
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
        uniffi.gardens_core.deleteRoom(orgId, roomId)
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
        uniffi.gardens_core.archiveRoom(orgId, roomId)
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
        uniffi.gardens_core.unarchiveRoom(orgId, roomId)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  @ReactMethod
  fun createEvent(
    orgId: String,
    title: String,
    description: String?,
    locationType: String,
    locationText: String?,
    locationRoomId: String?,
    startAt: Double,
    endAt: Double?,
    promise: Promise,
  ) {
    ensureLoaded()
    scope.launch {
      try {
        val eventId = uniffi.gardens_core.createEvent(
          orgId,
          title,
          description,
          locationType,
          locationText,
          locationRoomId,
          startAt.toLong(),
          endAt?.toLong(),
        )
        promise.resolve(eventId)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun updateEvent(
    orgId: String,
    eventId: String,
    title: String?,
    description: String?,
    locationType: String?,
    locationText: String?,
    locationRoomId: String?,
    startAt: Double?,
    endAt: Double?,
    promise: Promise,
  ) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.gardens_core.updateEvent(
          orgId,
          eventId,
          title,
          description,
          locationType,
          locationText,
          locationRoomId,
          startAt?.toLong(),
          endAt?.toLong(),
        )
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun deleteEvent(orgId: String, eventId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.gardens_core.deleteEvent(orgId, eventId)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun listEvents(orgId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val events = uniffi.gardens_core.listEvents(orgId)
        promise.resolve(eventsToWritableArray(events))
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun setEventRsvp(eventId: String, status: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.gardens_core.setEventRsvp(eventId, status)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun clearEventRsvp(eventId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        uniffi.gardens_core.clearEventRsvp(eventId)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun listEventRsvps(eventId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val rsvps = uniffi.gardens_core.listEventRsvps(eventId)
        promise.resolve(eventRsvpsToWritableArray(rsvps))
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
        val result = uniffi.gardens_core.sendMessage(
          roomId, dmThreadId, contentType, textContent, blobId, embedUrl, mentionsList, replyTo
        )
        val map = Arguments.createMap()
        map.putString("id", result.id)
        map.putString("opBytesBase64", Base64.encodeToString(result.opBytes, Base64.DEFAULT))
        promise.resolve(map)
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
        val messages = uniffi.gardens_core.listMessages(roomId, dmThreadId, limit.toUInt(), beforeTs)
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

  @ReactMethod
  fun deleteMessage(messageId: String, orgId: String?, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val result = uniffi.gardens_core.deleteMessage(messageId, orgId)
        val map = Arguments.createMap()
        map.putString("id", result.id)
        map.putString("opBytesBase64", Base64.encodeToString(result.opBytes, Base64.DEFAULT))
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun addReaction(messageId: String, emoji: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val result = uniffi.gardens_core.addReaction(messageId, emoji)
        val map = Arguments.createMap()
        map.putString("id", result.id)
        map.putString("opBytesBase64", Base64.encodeToString(result.opBytes, Base64.DEFAULT))
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun removeReaction(messageId: String, emoji: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val result = uniffi.gardens_core.removeReaction(messageId, emoji)
        val map = Arguments.createMap()
        map.putString("id", result.id)
        map.putString("opBytesBase64", Base64.encodeToString(result.opBytes, Base64.DEFAULT))
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun listReactions(messageIds: ReadableArray, promise: Promise) {
    ensureLoaded()
    val ids = (0 until messageIds.size()).map { messageIds.getString(it)!! }
    scope.launch {
      try {
        val reactions = uniffi.gardens_core.listReactions(ids)
        val arr = Arguments.createArray()
        for (r in reactions) {
          val map = Arguments.createMap()
          map.putString("messageId", r.messageId)
          map.putString("emoji", r.emoji)
          map.putString("reactorKey", r.reactorKey)
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
        val result = uniffi.gardens_core.createDmThread(recipientKey)
        val map = Arguments.createMap()
        map.putString("id", result.id)
        map.putString("opBytesBase64", Base64.encodeToString(result.opBytes, Base64.DEFAULT))
        promise.resolve(map)
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
        val threads = uniffi.gardens_core.listDmThreads()
        val arr = Arguments.createArray()
        for (t in threads) {
          val map = Arguments.createMap()
          map.putString("threadId", t.threadId)
          map.putString("initiatorKey", t.initiatorKey)
          map.putString("recipientKey", t.recipientKey)
          map.putDouble("createdAt", t.createdAt.toDouble())
          t.lastMessageAt?.let { map.putDouble("lastMessageAt", it.toDouble()) } ?: map.putNull("lastMessageAt")
          map.putBoolean("isRequest", t.isRequest)
          arr.pushMap(map)
        }
        promise.resolve(arr)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun deleteConversation(threadId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val result = uniffi.gardens_core.deleteConversation(threadId)
        val map = Arguments.createMap()
        map.putString("id", result.id)
        map.putString("opBytesBase64", Base64.encodeToString(result.opBytes, Base64.DEFAULT))
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  @ReactMethod
  fun leaveOrg(orgId: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val result = uniffi.gardens_core.leaveOrg(orgId)
        val map = Arguments.createMap()
        map.putString("id", result.id)
        map.putString("opBytesBase64", Base64.encodeToString(result.opBytes, Base64.DEFAULT))
        promise.resolve(map)
      } catch (e: Exception) {
        promise.reject("CoreError", e)
      }
    }
  }

  // ── Sync ─────────────────────────────────────────────────────────────────────

  @ReactMethod
  fun ingestOpFfi(topicHex: String, seq: Double, opBase64: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val opBytes = Base64.decode(opBase64, Base64.DEFAULT)
        uniffi.gardens_core.ingestOpFfi(topicHex, seq.toLong(), opBytes)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("SyncFfiError", e)
      }
    }
  }

  @ReactMethod
  fun getTopicSeqFfi(topicHex: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val seq = uniffi.gardens_core.getTopicSeqFfi(topicHex)
        promise.resolve(seq.toDouble())
      } catch (e: Exception) {
        promise.reject("SyncFfiError", e)
      }
    }
  }

  // ── Members ───────────────────────────────────────────────────────────────────

  @ReactMethod
  fun addMemberDirect(orgId: String, memberPublicKey: String, accessLevel: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val result = uniffi.gardens_core.addMemberDirect(orgId, memberPublicKey, accessLevel)
        val map = Arguments.createMap()
        map.putString("id", result.id)
        map.putString("opBytesBase64", Base64.encodeToString(result.opBytes, Base64.DEFAULT))
        promise.resolve(map)
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
        uniffi.gardens_core.removeMemberFromOrg(orgId, memberPublicKey)
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
        uniffi.gardens_core.changeMemberPermission(orgId, memberPublicKey, newAccessLevel)
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
        val members = uniffi.gardens_core.listOrgMembers(orgId)
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
    return uniffi.gardens_core.generateInviteToken(orgId, accessLevel, expiryTimestamp.toLong())
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  fun verifyInviteToken(tokenBase64: String, currentTimestamp: Double): WritableMap {
    ensureLoaded()
    val info = uniffi.gardens_core.verifyInviteToken(tokenBase64, currentTimestamp.toLong())
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
        val blobId = uniffi.gardens_core.uploadBlob(bytes, mimeType, roomId)
        promise.resolve(blobId)
      } catch (e: Exception) {
        promise.reject("BlobError", e)
      }
    }
  }

  @ReactMethod
  fun getBlob(blobHash: String, roomId: String?, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val bytes = uniffi.gardens_core.getBlob(blobHash, roomId)
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
        val packet       = uniffi.gardens_core.buildOnionPacket(hops, topicIdBytes, opBytes)
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
        val peeled = uniffi.gardens_core.peelOnionLayer(packet, recipientSeedHex)
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

  // ── Sync Configuration ────────────────────────────────────────────────────────

  @ReactMethod
  fun initSync(hopsArray: ReadableArray, syncUrl: String, promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val hops = (0 until hopsArray.size()).map { i ->
          val map = hopsArray.getMap(i)!!
          SyncHopFfi(
            pubkeyHex = map.getString("pubkeyHex")!!,
            nextUrl   = map.getString("nextUrl")!!,
          )
        }
        uniffi.gardens_core.initSync(hops, syncUrl)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("SyncConfigError", e)
      }
    }
  }

  @ReactMethod
  fun getRelayHops(promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val hops = uniffi.gardens_core.getRelayHops()
        val arr = Arguments.createArray()
        for (h in hops) {
          val map = Arguments.createMap()
          map.putString("pubkeyHex", h.pubkeyHex)
          map.putString("nextUrl", h.nextUrl)
          arr.pushMap(map)
        }
        promise.resolve(arr)
      } catch (e: Exception) {
        promise.reject("SyncConfigError", e)
      }
    }
  }

  @ReactMethod
  fun getSyncUrl(promise: Promise) {
    ensureLoaded()
    scope.launch {
      try {
        val url = uniffi.gardens_core.getSyncUrl()
        promise.resolve(url)
      } catch (e: Exception) {
        promise.reject("SyncConfigError", e)
      }
    }
  }

  // ── Email ─────────────────────────────────────────────────────────────────────

  @ReactMethod
  fun prepareOutboundEmail(
    to: String,
    subject: String,
    bodyText: String,
    bodyHtml: String?,
    replyToMessageId: String?,
    promise: Promise,
  ) {
    ensureLoaded()
    scope.launch {
      try {
        val json = uniffi.gardens_core.prepareOutboundEmail(to, subject, bodyText, bodyHtml, replyToMessageId)
        promise.resolve(json)
      } catch (e: Exception) {
        promise.reject("EmailError", e)
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
      o.welcomeText?.let { map.putString("welcomeText", it) } ?: map.putNull("welcomeText")
      o.customEmojiJson?.let { map.putString("customEmojiJson", it) } ?: map.putNull("customEmojiJson")
      o.orgCooldownSecs?.let { map.putDouble("orgCooldownSecs", it.toDouble()) } ?: map.putNull("orgCooldownSecs")
      map.putBoolean("isPublic", o.isPublic)
      map.putString("creatorKey", o.creatorKey)
      o.orgPubkey?.let { map.putString("orgPubkey", it) } ?: map.putNull("orgPubkey")
      map.putDouble("createdAt", o.createdAt.toDouble())
      arr.pushMap(map)
    }
  }

  private fun eventsToWritableArray(events: List<Event>) = Arguments.createArray().also { arr ->
    for (e in events) {
      val map = Arguments.createMap()
      map.putString("eventId", e.eventId)
      map.putString("orgId", e.orgId)
      map.putString("title", e.title)
      e.description?.let { map.putString("description", it) } ?: map.putNull("description")
      map.putString("locationType", e.locationType)
      e.locationText?.let { map.putString("locationText", it) } ?: map.putNull("locationText")
      e.locationRoomId?.let { map.putString("locationRoomId", it) } ?: map.putNull("locationRoomId")
      map.putDouble("startAt", e.startAt.toDouble())
      e.endAt?.let { map.putDouble("endAt", it.toDouble()) } ?: map.putNull("endAt")
      map.putString("createdBy", e.createdBy)
      map.putDouble("createdAt", e.createdAt.toDouble())
      map.putBoolean("isDeleted", e.isDeleted)
      arr.pushMap(map)
    }
  }

  private fun eventRsvpsToWritableArray(rsvps: List<EventRsvp>) = Arguments.createArray().also { arr ->
    for (r in rsvps) {
      val map = Arguments.createMap()
      map.putString("eventId", r.eventId)
      map.putString("memberKey", r.memberKey)
      map.putString("status", r.status)
      map.putDouble("updatedAt", r.updatedAt.toDouble())
      arr.pushMap(map)
    }
  }
}
