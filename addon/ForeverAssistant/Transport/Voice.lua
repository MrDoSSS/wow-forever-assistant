-- Silent SAPI transport. The local voice performs HTTP; addon Lua never does.
-- No pixel fallback: loss of the bridge only causes bounded automatic retries.
local _, FA = ...
local Voice = { nextAt = 0, nonce = 0, incoming = nil, inflight = nil, utterances = {}, stats = { sent = 0, chunks = 0, packets = 0, errors = 0, suppressedCues = 0 } }
FA.Voice = Voice
local NAME = "Forever Assistant Silent Bridge 3"
local MAX_BYTES, CHUNK_BYTES = 524288, 512
local cache = setmetatable({}, { __mode = "k" })

function Voice.enabled()
  return ForeverAssistantConfig and ForeverAssistantConfig.transport == "silent_voice"
end

-- Blizzard's TextToSpeechFrame plays UI_VOICECHAT_TTSMESSAGE on every
-- playback-finished/failed event, even for this voice's silent audio. A
-- protocol bookmark identifies our utterance before playback finishes.
-- Filter only those events; leave normal narration and its settings alone.
function Voice.installTtsFilter()
  local frame = TextToSpeechFrame
  if not frame or Voice.ttsFrame == frame or type(frame.GetScript) ~= "function" then return end
  local original = frame:GetScript("OnEvent")
  if type(original) ~= "function" then return end
  local function filtered(self, event, ...)
    local utteranceID = ...
    local own = Voice.utterances[utteranceID]
    if Voice.enabled() and own and FA.Core.now() - own < 60
      and (event == "VOICE_CHAT_TTS_PLAYBACK_FINISHED" or event == "VOICE_CHAT_TTS_PLAYBACK_FAILED") then
      Voice.stats.suppressedCues = Voice.stats.suppressedCues + 1
      return
    end
    return original(self, event, ...)
  end
  if pcall(frame.SetScript, frame, "OnEvent", filtered) then Voice.ttsFrame = frame end
end

local function unavailable(message)
  FA.Core.ui("setStatus", message); Voice.lastError = message
  Voice.stats.errors = Voice.stats.errors + 1
  Voice.nextAt = FA.Core.now() + 2
  Voice.inflight = nil
end

local function findVoice()
  if Voice.voiceID then return true end
  if not C_VoiceChat or not C_VoiceChat.GetTtsVoices or not C_VoiceChat.SpeakText then
    unavailable("Silent connection unavailable: TTS API missing."); return false
  end
  if not C_EncodingUtil or not C_EncodingUtil.DeserializeJSON then
    unavailable("Silent connection unavailable: JSON API missing."); return false
  end
  local ok, voices = pcall(C_VoiceChat.GetTtsVoices)
  for _, voice in ipairs(ok and voices or {}) do
    if voice.name == NAME then Voice.voiceID = voice.voiceID; return true end
  end
  unavailable("Silent connection voice missing. Install the voice and reload the UI.")
  return false
end

local function frameHex(item, index)
  local fragments = cache[item]
  if not fragments then fragments = {}; cache[item] = fragments end
  if not fragments[index] then
    local bytes, out = FA.Codec.frameBytes(item, index), {}
    for i = 1, #bytes do out[i] = string.format("%02x", bytes[i]) end
    fragments[index] = table.concat(out)
  end
  return fragments[index]
end

local function unhex(text)
  if #text % 2 ~= 0 or text:find("[^0-9a-f]") then return nil end
  return (text:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end))
end

local function checksum(text)
  local a, b = 0, 0
  for i = 1, #text do a = (a + string.byte(text, i)) % 255; b = (b + a) % 255 end
  return a + 256 * b
end

function Voice.onBookmark(mark, utteranceID)
  if not Voice.enabled() or type(mark) ~= "string" or #mark > 2048 then return end
  if mark:sub(1, 5) == "FAV2:" and type(utteranceID) == "number" then
    Voice.utterances[utteranceID] = FA.Core.now()
    Voice.installTtsFilter()
  end
  if mark == "FAV2:OFFLINE" then
    unavailable("Assistant is offline. Start WoW Forever Assistant; reconnecting automatically."); return
  end
  local errorStage, errorCode = mark:match("^FAV2:ERROR:([%w_]+):(%x+)$")
  if errorStage then
    unavailable("Assistant connection failed (" .. errorStage .. "/" .. errorCode .. "). Retrying..."); return
  end
  local session = FA.Assistant.session
  local okOrigin = mark:match("^FAV2:OK:(%x+):%d+$")
  if okOrigin == session.origin then
    Voice.inflight = nil; Voice.lastError = nil
    if not FA.Outbound.hasPending() then FA.Assistant.afterRead(FA.Core.now()) end
    return
  end
  local origin, revision, index, count, length, sum, hex = mark:match("^FAV2:DATA:(%x+):(%d+):(%d+):(%d+):(%d+):(%d+):([0-9a-f]+)$")
  if origin ~= session.origin then return end
  -- An already applied packet is still a successful response to our poll.
  -- It must release the in-flight request rather than wait for a timeout.
  Voice.inflight = nil
  revision, index, count, length, sum = tonumber(revision), tonumber(index), tonumber(count), tonumber(length), tonumber(sum)
  if not revision or revision > 9007199254740991 or revision <= session.lastRevision
    or count < 1 or count > 1024 or index >= count or length < 1 or length > MAX_BYTES
    or count ~= math.ceil(length / CHUNK_BYTES) or sum > 65535 then return end
  local part = unhex(hex)
  local expected = index == count - 1 and (length - index * CHUNK_BYTES) or CHUNK_BYTES
  if not part or #part ~= expected then return end
  local incoming = Voice.incoming
  if incoming and incoming.revision > revision then return end
  if not incoming or incoming.revision ~= revision then
    incoming = { revision = revision, count = count, length = length, sum = sum, parts = {}, next = 0 }
    Voice.incoming = incoming
  end
  if incoming.count ~= count or incoming.length ~= length or incoming.sum ~= sum then return end
  if incoming.parts[index + 1] and incoming.parts[index + 1] ~= part then return end
  incoming.parts[index + 1] = part
  while incoming.parts[incoming.next + 1] do incoming.next = incoming.next + 1 end
  Voice.inflight = nil; Voice.lastError = nil; Voice.stats.chunks = Voice.stats.chunks + 1
  if incoming.next < count then return end
  local json = table.concat(incoming.parts)
  Voice.incoming = nil
  if #json ~= length or checksum(json) ~= sum then unavailable("Reply transfer failed. Retrying..."); return end
  local decoded, packet = pcall(C_EncodingUtil.DeserializeJSON, json)
  if not decoded or type(packet) ~= "table" or packet.publicationRevision ~= revision then
    unavailable("Could not decode assistant reply. Retrying..."); return
  end
  if FA.Assistant.applyPacket(packet) then
    Voice.stats.packets = Voice.stats.packets + 1
    FA.Inbound.stats.packets = FA.Inbound.stats.packets + 1
    if not FA.Outbound.hasPending() then FA.Assistant.afterRead(FA.Core.now()) end
  end
end

function Voice.tick(now)
  FA.Outbound.hide()
  Voice.installTtsFilter()
  for id, at in pairs(Voice.utterances) do if now - at >= 60 then Voice.utterances[id] = nil end end
  if now < Voice.nextAt then return end
  if Voice.inflight then
    if now - Voice.inflight < 4 then return end
    unavailable("Assistant connection timed out. Retrying automatically..."); return
  end
  if not FA.Assistant.session.ready then return end
  local idle = not FA.Outbound.hasPending() and not FA.Inbound.running
  if not findVoice() then return end
  local frame = ""
  local item, index = FA.Outbound.nextFrame(now)
  if item then frame = frameHex(item, index) end
  local session, incoming = FA.Assistant.session, Voice.incoming
  Voice.nonce = Voice.nonce + 1
  local command = table.concat({ "FAV2", session.origin, tostring(session.lastRevision),
    tostring(incoming and incoming.revision or 0), tostring(incoming and incoming.next or 0), frame, tostring(Voice.nonce) }, ":")
  -- A heartbeat remains active after the legacy LoD timer stops. The nonce
  -- also prevents identical empty polls from being coalesced by the TTS host.
  Voice.inflight = now; Voice.nextAt = now + (idle and 2 or 0.5)
  local ok = pcall(C_VoiceChat.SpeakText, Voice.voiceID, command, 0, 100, false)
  if not ok then unavailable("Could not send to the assistant. Retrying automatically..."); return end
  Voice.stats.sent = Voice.stats.sent + 1
  FA.Inbound.stats.reads = FA.Inbound.stats.reads + 1
end

if CreateFrame then
  local events = CreateFrame("Frame")
  events:RegisterEvent("VOICE_CHAT_TTS_PLAYBACK_BOOKMARK")
  events:SetScript("OnEvent", function(_, _, utteranceID, bookmark) Voice.onBookmark(bookmark, utteranceID) end)
end
