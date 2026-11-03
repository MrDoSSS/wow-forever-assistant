-- Addon protocol: identity, sessions, outgoing messages, packet application,
-- Stop, policy, conversation clearing and polling rules.
local _, FA = ...
local Assistant = {}
FA.Assistant = Assistant

local Json = FA.Json
local NULL = Json.null
local Core = FA.Core

local MAX_TEXT = 16384
local MAX_APPLIED = 64
local MAX_HISTORY = 200
local SERVICE_READS = 6
local QUERY_ACK_SECONDS = 300

-- Current unsaved game session: originSessionId changes after /reload.
local session = {
  ready = false,
  origin = nil,
  sequence = 0,
  identity = nil,
  characterKey = nil,
  lastRevision = 0,
  serviceReads = 0,
  receiptsInFlight = {},
  limitations = {},
}
Assistant.session = session

local state -- current character state in ForeverAssistantDB

local function keyString(key)
  return tostring(key.originSessionId) .. ":" .. tostring(key.requestId)
end

local function sameKey(a, b)
  return a and b and a.characterKey == b.characterKey and a.originSessionId == b.originSessionId and a.requestId == b.requestId
end

function Assistant.entryId(key, role)
  return string.sub(FA.Sha256.hex(key.characterKey .. "|" .. key.originSessionId .. "|" .. key.requestId .. "|" .. role), 1, 32)
end

local function defaultPolicy()
  local groups = {}
  for i, name in ipairs(FA.Context.GROUPS) do groups[i] = name end
  return { revision = 1, resetEpoch = 0, enabledGroups = groups }
end

local function policyBody(policy)
  local groups = Json.array()
  for i, name in ipairs(policy.enabledGroups) do groups[i] = name end
  return { revision = policy.revision, resetEpoch = policy.resetEpoch, enabledGroups = groups }
end

local function identityBody()
  local id = session.identity
  return { serverNamespace = id.serverNamespace, realm = id.realm, playerGuid = id.playerGuid, displayName = id.displayName }
end

local function requestBody(key)
  return { characterKey = key.characterKey, originSessionId = key.originSessionId, requestId = key.requestId }
end

local function conversationTitle(text)
  local title = text:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|cnIQ%d+:", ""):gsub("|H.-|h(.-)|h", "%1"):gsub("|r", ""):gsub("|", "")
  return Core.utf8Truncate((title:match("[^\r\n]+") or title), 64)
end

local function characterState(characterKey)
  ForeverAssistantDB = ForeverAssistantDB or {}
  local db = ForeverAssistantDB
  db.version = 2
  db.characters = db.characters or {}
  local s = db.characters[characterKey]
  if not s then
    s = {}
    db.characters[characterKey] = s
  end
  s.conversationId = s.conversationId or Core.newId()
  s.policy = s.policy or defaultPolicy()
  s.applied = s.applied or {}
  s.outbound = s.outbound or {}
  s.cancelled = s.cancelled or {}
  s.pendingDeletes = s.pendingDeletes or {}
  s.history = s.history or {}
  -- Migrate the old single conversation into the first saved conversation.
  s.chats = s.chats or {}
  local selected
  for _, chat in ipairs(s.chats) do
    if chat.id == s.conversationId then selected = chat; break end
  end
  if not selected then
    selected = { id = s.conversationId, history = s.history, title = "New conversation", draft = "" }
    for _, entry in ipairs(s.history) do
      if entry.role == "user" then selected.title = conversationTitle(entry.text); break end
    end
    table.insert(s.chats, 1, selected)
  end
  selected.history = selected.history or {}
  s.history = selected.history
  return s
end

function Assistant.currentChat()
  if not state then return nil end
  for _, chat in ipairs(state.chats) do
    if chat.id == state.conversationId then return chat end
  end
end

local function replaceHistory(history)
  state.history = history
  local chat = Assistant.currentChat()
  if chat then chat.history = history end
end

local function replaceConversation(id)
  local chat = Assistant.currentChat()
  if chat then chat.id = id; chat.title = "New conversation"; chat.draft = "" end
  state.conversationId = id
  replaceHistory({})
end

function Assistant.setDraft(text)
  local chat = Assistant.currentChat()
  if chat then chat.draft = Core.utf8Truncate(text or "", MAX_TEXT) end
end

-- Identity: installed server namespace and client-provided realm/GUID.
function Assistant.collectIdentity()
  local config = ForeverAssistantConfig or {}
  local namespace = config.serverNamespace
  local guid = Core.try(UnitGUID, "player")
  local realm = Core.try(GetRealmName)
  local name = Core.try(UnitName, "player")
  for _, value in ipairs({ namespace, guid, realm, name }) do
    if type(value) ~= "string" or value == "" or #value > 1024 then return nil end
  end
  return { serverNamespace = namespace, realm = realm, playerGuid = guid, displayName = name }
end

function Assistant.characterKeyOf(identity)
  return FA.Sha256.hex(Json.encode(Json.array({ identity.serverNamespace, identity.realm, identity.playerGuid })))
end

function Assistant.start()
  local identity = Assistant.collectIdentity()
  if not identity then
    -- Without a verified identity, allow diagnostics only.
    Core.ui("setStatus", "Cannot determine the character identity or server namespace: check the installation.")
    return false
  end
  session.identity = identity
  session.characterKey = Assistant.characterKeyOf(identity)
  session.origin = Core.newId()
  session.sequence = 0
  session.lastRevision = 0
  state = characterState(session.characterKey)
  Assistant.state = state
  -- Alt character data: the bridge reads SavedVariables (Collectors/Alts.lua).
  FA.Alts.attach(identity, session.characterKey)
  -- Replace the old game session's HELLO; retrying it after /reload would
  -- point the bridge to a session that no longer exists. Retry other messages unchanged.
  for i = #state.outbound, 1, -1 do
    if state.outbound[i].type == "HELLO" then table.remove(state.outbound, i) end
  end
  FA.Outbound.attach(state.outbound)
  session.ready = true
  Assistant.hello()
  Core.ui("render")
  return true
end

-- Sending: envelope -> JSON -> frame queue. bodyFor receives the message sequence;
-- for QUERY, snapshotId = requestId = messageSequence.
function Assistant.send(messageType, bodyFor, urgent)
  if not session.ready then return nil, "not_ready" end
  local sequence = session.sequence + 1
  local envelope = {
    version = 1,
    type = messageType,
    originSessionId = session.origin,
    messageSequence = sequence,
    characterKey = session.characterKey,
    body = bodyFor(sequence),
  }
  local bytes = Json.encode(envelope)
  if #bytes > FA.Codec.MAX_MESSAGE then return nil, "too_large" end
  local item = {
    kind = FA.Codec.KINDS[messageType],
    type = messageType,
    origin = session.origin,
    sequence = sequence,
    bytes = bytes,
  }
  if not FA.Outbound.enqueue(item, urgent) then return nil, "queue_full" end
  session.sequence = sequence
  local now = Core.now()
  if FA.Inbound.paused then FA.Inbound.restart(now) else FA.Inbound.start(now) end
  FA.Outbound.suspended = false
  return item
end

function Assistant.hello()
  local pending = Json.array()
  if state.active then pending[1] = requestBody(state.active.key) end
  local applied = Json.array()
  for i, id in ipairs(state.applied) do applied[i] = id end
  local item, reason = Assistant.send("HELLO", function()
    return {
      identity = identityBody(),
      deliverySessionId = session.origin,
      conversationId = state.conversationId,
      policy = policyBody(state.policy),
      pendingRequests = pending,
      appliedDeliveryIds = applied,
      historyCursor = NULL,
    }
  end)
  FA.Inbound.restart(Core.now())
  return item, reason
end

-- Allow one active question per character; keep a second as a draft.
function Assistant.ask(text)
  if not session.ready then return nil, "not_ready" end
  if state.active then return nil, "busy" end
  if state.pendingClear then return nil, "clearing" end
  if type(text) ~= "string" or text == "" or #text > MAX_TEXT then return nil, "bad_text" end
  local key
  -- Shift+clicked item links are sent both in text and itemRefs.
  local itemRefs = FA.Items.extract(text)
  local item, reason = Assistant.send("QUERY", function(sequence)
    key = { characterKey = session.characterKey, originSessionId = session.origin, requestId = sequence }
    return {
      identity = identityBody(),
      conversationId = state.conversationId,
      policy = policyBody(state.policy),
      text = text,
      itemRefs = itemRefs,
      snapshot = FA.Context.collect(state.policy, sequence, itemRefs),
      activePlan = FA.Plan.queryRef() or NULL,
    }
  end)
  if not item then return nil, reason end
  -- The plan active when the question was asked; only its correction auto-replaces it.
  local plan = FA.Plan.active()
  state.active = { key = key, acked = false, sentAt = Core.now(), planEntryId = plan and plan.entryId or nil }
  local chat = Assistant.currentChat()
  if chat then
    if #state.history == 0 then
      chat.title = conversationTitle(text)
    end
    chat.draft = ""
  end
  session.serviceReads = 0
  Assistant.addHistory({ entryId = Assistant.entryId(key, "user"), role = "user", text = text, pending = true })
  Core.ui("setStatus", "Question sent, waiting for the answer...")
  return key
end

-- Stop: remember the key immediately, suppress late text, then send CANCEL.
function Assistant.stop()
  local active = state and state.active
  if not active then return false end
  state.cancelled[keyString(active.key)] = true
  state.active = nil
  Assistant.send("CANCEL", function() return { request = requestBody(active.key) } end, true)
  Core.ui("setStatus", "Question stopped.")
  Core.ui("render")
  return true
end

function Assistant.retry()
  FA.Outbound.suspended = false
  FA.Inbound.restart(Core.now())
  session.serviceReads = 0
  Core.ui("setStatus", "Checking again...")
end

-- Policy mode: "keep" preserves memory; "reset" starts over.
function Assistant.setGroup(name, enabled, mode)
  local policy = state.policy
  local groups = {}
  for _, group in ipairs(FA.Context.GROUPS) do
    local on = false
    for _, current in ipairs(policy.enabledGroups) do if current == group then on = true end end
    if group == name then on = enabled end
    if on then groups[#groups + 1] = group end
  end
  state.policy = {
    revision = policy.revision + 1,
    resetEpoch = policy.resetEpoch + ((not enabled and mode == "reset") and 1 or 0),
    enabledGroups = groups,
  }
  return Assistant.send("POLICY", function() return { identity = identityBody(), policy = policyBody(state.policy) } end)
end

-- Clear the selected conversation: clear the display immediately; send again after cleared.
function Assistant.clearHistory()
  if state.pendingClear then return nil, "clearing" end
  if state.active then Assistant.stop() end
  local operationId, replacement = Core.newId(), Core.newId()
  local old = state.conversationId
  local item, reason = Assistant.send("CLEAR_HISTORY", function()
    return { identity = identityBody(), operationId = operationId, conversationId = old, replacementConversationId = replacement }
  end)
  if not item then return nil, reason end
  state.pendingClear = { operationId = operationId, old = old, replacement = replacement }
  replaceHistory({})
  Core.ui("render")
  Core.ui("setStatus", "Clearing is waiting for the bridge...")
  return operationId
end

-- Deleting removes the conversation immediately; its clear confirmation must not change a newer selection.
-- Keep CLEAR_HISTORY in the outgoing queue and retry it after /reload.
function Assistant.deleteChat(id)
  if not state or not session.ready then return nil, "not_ready" end
  if state.pendingClear then return nil, "clearing" end
  id = id or state.conversationId
  local index
  for i, chat in ipairs(state.chats) do if chat.id == id then index = i; break end end
  if not index then return nil, "not_found" end
  local operationId, replacement = Core.newId(), Core.newId()
  local item, reason = Assistant.send("CLEAR_HISTORY", function()
    return { identity = identityBody(), operationId = operationId, conversationId = id,
      replacementConversationId = replacement, deleteChat = true }
  end)
  if not item then return nil, reason end
  state.pendingDeletes[operationId] = { old = id, replacement = replacement }
  if id == state.conversationId and state.active then
    state.cancelled[keyString(state.active.key)] = "deleted"
    state.active = nil
  end
  table.remove(state.chats, index)
  if #state.chats == 0 then
    state.chats[1] = { id = replacement, title = "New conversation", history = {}, draft = "" }
  end
  if id == state.conversationId then
    local nextChat = state.chats[math.min(index, #state.chats)]
    state.conversationId, state.history = nextChat.id, nextChat.history
  end
  Core.ui("render")
  if not state.active then Core.ui("setStatus", "Conversation deleted. History removal is queued.") end
  return operationId
end

function Assistant.selectChat(id)
  if not state or not session.ready then return false, "not_ready" end
  if id == state.conversationId then return true end
  if state.active or state.pendingClear then return false, "busy" end
  local selected
  for _, chat in ipairs(state.chats) do if chat.id == id then selected = chat; break end end
  if not selected then return false, "not_found" end
  state.conversationId, state.history = id, selected.history
  -- Selecting saved conversations does not start transport; QUERY carries the conversation ID.
  Core.ui("setStatus", "Conversation selected.")
  Core.ui("render")
  return true
end

function Assistant.refreshHistory()
  if not state or not session.ready then return nil, "not_ready" end
  if state.active or state.pendingClear then return nil, "busy" end
  local item, reason = Assistant.hello()
  if item then Core.ui("setStatus", "History refresh requested.") end
  return item, reason
end

function Assistant.newChat()
  if not state or not session.ready then return false, "not_ready" end
  if state.active or state.pendingClear then return false, "busy" end
  local chat = { id = Core.newId(), history = {}, title = "New conversation", draft = "" }
  table.insert(state.chats, 1, chat)
  local ok, reason = Assistant.selectChat(chat.id)
  if not ok then table.remove(state.chats, 1) end
  return ok, reason
end

-- UI history: deduplicate entries by entryId.
function Assistant.addHistory(entry)
  for _, existing in ipairs(state.history) do
    if existing.entryId == entry.entryId then return end
  end
  state.history[#state.history + 1] = entry
  while #state.history > MAX_HISTORY do table.remove(state.history, 1) end
  Core.ui("render")
end

-- A final outcome ends the reply wait; service acknowledgments restart
-- the schedule with at most six reads.
local function finish(key, message)
  if state.active and sameKey(state.active.key, key) then
    state.active = nil
    session.serviceReads = 0
    FA.Inbound.restart(Core.now())
  end
  if message then Core.ui("setStatus", message) end
  Core.ui("render")
end

local function rememberApplied(deliveryId)
  table.insert(state.applied, deliveryId)
  while #state.applied > MAX_APPLIED do table.remove(state.applied, 1) end
end

local function isApplied(deliveryId)
  for _, id in ipairs(state.applied) do if id == deliveryId then return true end end
  return false
end

local applyDelivery = {}

function applyDelivery.hello(body)
  -- A late HELLO for another conversation must not change the player's selection.
  if body.conversationId ~= state.conversationId then
    local pending = state.pendingClear
    if pending and body.conversationId == pending.replacement then
      replaceConversation(body.conversationId)
      state.pendingClear = nil
    else
      return
    end
  end
  session.limitations = body.limitations or {}
  Core.ui("render")
end

-- The bridge's first history page is authoritative; retain player entries not
-- yet accepted by the bridge afterward. locations comes from history;
-- legacy single approxLocation and limitations come from the local cache.
function applyDelivery.history(body)
  if body.conversationId ~= state.conversationId then return end
  local merged, seen, known = {}, {}, {}
  for _, entry in ipairs(state.history) do known[entry.entryId] = entry end
  for _, entry in ipairs(body.entries or {}) do
    local old = known[entry.entryId] or {}
    merged[#merged + 1] = {
      entryId = entry.entryId,
      role = entry.role,
      text = entry.text,
      itemRefs = entry.role == "assistant" and entry.itemRefs or nil,
      locationRef = entry.locationRef,
      approxLocation = old.approxLocation,
      locations = entry.locations or old.locations,
      limitations = old.limitations,
      plan = entry.plan or old.plan,
      request = (entry.plan or old.plan) and (entry.request or old.request) or nil,
    }
    seen[entry.entryId] = true
  end
  for _, entry in ipairs(state.history) do
    if entry.pending and not seen[entry.entryId] then merged[#merged + 1] = entry end
  end
  replaceHistory(merged)
  Core.ui("render")
end

function applyDelivery.status(body, request)
  if not (state.active and sameKey(state.active.key, request)) then return end
  if body.state == "cancelled" or body.state == "failed" then
    finish(request, body.state == "cancelled" and "Question cancelled." or "Question was not processed.")
  else
    state.active.acked = true
  end
end

-- Model-requested Auctionator prices (lookup_prices) and client item information
-- (lookup_items, itemInfo=true) are read when the request is applied. Item information
-- may wait for the client cache to load.
function applyDelivery.price_lookup(body, request)
  local items = body.items or {}
  local function send(itemInfo)
    local observations, reason = FA.Prices.lookup(items, session.origin)
    Assistant.send("PRICE_RESULT", function()
      return {
        request = requestBody(request),
        lookupId = body.lookupId,
        observations = observations or Json.array(),
        unavailableReason = observations and NULL or reason,
        itemInfo = itemInfo,
      }
    end)
  end
  if body.itemInfo then FA.ItemInfo.collect(items, send) else send(nil) end
end

function applyDelivery.reply(body, request)
  local text = body.text or ""
  -- Do not display a clarification twice when the model repeated it in the reply text.
  local clarification = type(body.clarification) == "string" and body.clarification:match("^%s*(.-)%s*$") or ""
  if clarification ~= "" and not string.find(text, clarification, 1, true) then text = text .. "\n\n" .. clarification end
  local userEntry = Assistant.entryId(request, "user")
  for _, entry in ipairs(state.history) do
    if entry.entryId == userEntry then entry.pending = nil end
  end
  Assistant.addHistory({
    entryId = Assistant.entryId(request, "assistant"),
    role = "assistant",
    text = text,
    status = body.status,
    itemRefs = body.itemRefs,
    locationRef = body.locationRef,
    approxLocation = body.approxLocation,
    locations = body.locations,
    limitations = body.limitations,
    plan = body.plan,
    request = body.plan and request or nil,
  })
  local asked = state.active and sameKey(state.active.key, request) and state.active.planEntryId
  local revised = false
  if type(body.plan) == "table" and body.plan.revises and asked then
    local entryId = Assistant.entryId(request, "assistant")
    for _, entry in ipairs(state.history) do
      if entry.entryId == entryId then revised = FA.Plan.revise(entry, asked) end
    end
  end
  finish(request, revised and "Answer received. The active plan was updated."
    or (body.status == "needs_data" and "Clarification needed." or "Answer received."))
end

function applyDelivery.error(body, request)
  Core.ui("setStatus", tostring(body.text or body.code))
  if request then finish(request, nil) end
end

function applyDelivery.cleared(body)
  local deleted = state.pendingDeletes[body.operationId]
  if deleted and deleted.old == body.oldConversationId then
    state.pendingDeletes[body.operationId] = nil
    if not state.active then Core.ui("setStatus", "Conversation deleted.") end
    return
  end
  local pending = state.pendingClear
  if (pending and pending.operationId == body.operationId) or body.oldConversationId == state.conversationId then
    replaceConversation(body.replacementConversationId)
    state.pendingClear = nil
    Core.ui("render")
    Core.ui("setStatus", "Chat history cleared.")
  end
end

-- LoD packet: verify character, delivery session and revision, then process ACKs and deliveries.
function Assistant.applyPacket(packet)
  if not session.ready or type(packet) ~= "table" or packet.version ~= 1 then return false end
  if packet.targetCharacterKey ~= session.characterKey or packet.targetDeliverySessionId ~= session.origin then return false end
  local revision = packet.publicationRevision
  if type(revision) ~= "number" or revision <= session.lastRevision then return false end
  session.lastRevision = revision

  for _, key in ipairs(packet.acceptedMessageKeys or {}) do
    local item = FA.Outbound.ack(key.originSessionId, key.messageSequence)
    if item then
      if item.type == "QUERY" and state.active and state.active.key.originSessionId == item.origin and state.active.key.requestId == item.sequence then
        state.active.acked = true
        Core.ui("setStatus", "Question accepted by the bridge, waiting for the answer...")
      elseif item.type == "RECEIPTS" then
        for id, sequence in pairs(session.receiptsInFlight) do
          if sequence == item.sequence then session.receiptsInFlight[id] = nil end
        end
      end
    end
  end

  local receipts = {}
  for _, delivery in ipairs(packet.deliveries or {}) do
    if type(delivery) == "table" and type(delivery.deliveryId) == "string" then
      local id = delivery.deliveryId
      if not isApplied(id) then
        local request = delivery.request
        local cancelled = request and state.cancelled[keyString(request)]
        local suppressed = cancelled and (delivery.type ~= "error" or cancelled == "deleted")
        local handler = applyDelivery[delivery.type]
        if handler and not suppressed then handler(delivery.body or {}, request) end
        rememberApplied(id)
      end
      if not session.receiptsInFlight[id] then receipts[#receipts + 1] = id end
    end
  end
  while #receipts > 0 do
    local chunk = Json.array()
    while #receipts > 0 and #chunk < 64 do chunk[#chunk + 1] = table.remove(receipts, 1) end
    local item = Assistant.send("RECEIPTS", function() return { deliveryIds = chunk } end)
    if item then
      for _, id in ipairs(chunk) do session.receiptsInFlight[id] = item.sequence end
    end
  end
  return true
end

-- After each read, continue, pause or stop polling.
function Assistant.afterRead(now)
  if FA.Inbound.paused and string.match(FA.Inbound.paused, "^slots_") then return end
  local active = state and state.active
  if active then
    if not active.acked and now - (active.sentAt or now) >= QUERY_ACK_SECONDS then
      FA.Inbound.pause("query_unacked")
      Core.ui("setStatus", "The bridge has not confirmed receipt. Check that it is running, or press Stop.")
    end
    return
  end
  if FA.Outbound.hasPending() then
    session.serviceReads = session.serviceReads + 1
    if session.serviceReads >= SERVICE_READS then
      FA.Inbound.pause("service")
      FA.Outbound.suspended = true
      Core.ui("setStatus", "Waiting for the bridge. Check that it is running; /fa retry reconnects.")
    end
    return
  end
  FA.Inbound.stop()
  session.serviceReads = 0
end

function Assistant.onSlotsLow(left)
  Core.ui("setStatus", string.format("Only %d exchange slots remain. Reload the UI to restore them.", left))
  Core.ui("notifySlots", left)
end

function Assistant.onSlotsExhausted(reason)
  FA.Inbound.pause("slots_" .. tostring(reason))
  if reason == "exhausted" then
    Core.ui("setStatus", "Exchange slots are used up. Reload the UI to continue; your question and queue are kept.")
    Core.ui("notifySlots", 0)
  else
    Core.ui("setStatus", "Cannot load exchange slots: the client addon API is unavailable. Check the installation.")
  end
end

function Assistant.onSlotFailed(name, reason)
  Core.ui("setStatus", "Slot " .. name .. " did not load: " .. tostring(reason))
end

function Assistant.status()
  local voice = FA.Voice and FA.Voice.enabled()
  return {
    transport = voice and "silent_voice" or "pixels",
    ready = session.ready,
    characterKey = session.characterKey,
    origin = session.origin,
    queue = #FA.Outbound.queue,
    reads = FA.Inbound.stats.reads,
    slotsLeft = not voice and FA.Inbound.slotsLeft() or nil,
    paused = FA.Inbound.paused,
    active = state and state.active and keyString(state.active.key) or nil,
  }
end
