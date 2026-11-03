-- Addon core: namespace, utilities, events and shared timer.
-- Compatible with Lua 5.1 in the client and Lua 5.3 in fengari tests.
local addonName, FA = ...
FA = FA or {}
ForeverAssistant = FA
FA.name = addonName or "ForeverAssistant"
FA.VERSION = "0.4.6"
FA.UI = FA.UI or {}

local Core = {}
FA.Core = Core

local unpackFn = unpack or table.unpack

local function pack(...)
  return { n = select("#", ...), ... }
end

-- Protected client API call: missing functions or errors return nil.
function Core.try(fn, ...)
  if type(fn) ~= "function" then return nil end
  local result = pack(pcall(fn, ...))
  if not result[1] then return nil end
  return unpackFn(result, 2, result.n)
end

function Core.now()
  return GetTime()
end

-- Client language as GetLocale reports it (enUS, ruRU, zhCN...); enUS when unknown.
function Core.locale()
  local locale = Core.try(GetLocale)
  if type(locale) == "string" and string.match(locale, "^%l%l%u%u$") then return locale end
  return "enUS"
end

-- Snapshot/observation time: floor(GetTime()*1000) within the original game session.
function Core.sessionMs()
  return math.floor(GetTime() * 1000)
end

local idCounter = 0

-- Identity, not a secret: time, random generator and counter.
function Core.newId()
  idCounter = idCounter + 1
  local parts = {
    tostring(time and time() or 0),
    string.format("%.3f", GetTime()),
    tostring(math.random()),
    tostring(idCounter),
    tostring({}),
  }
  return string.sub(FA.Sha256.hex(table.concat(parts, "|")), 1, 32)
end

-- Truncate at a UTF-8 character boundary.
function Core.utf8Truncate(text, maxBytes)
  if #text <= maxBytes then return text end
  local cut = maxBytes
  while cut > 0 do
    local nextByte = string.byte(text, cut + 1)
    if not nextByte or nextByte < 0x80 or nextByte >= 0xC0 then break end
    cut = cut - 1
  end
  return string.sub(text, 1, cut)
end

function Core.print(message)
  local chat = DEFAULT_CHAT_FRAME
  if chat and chat.AddMessage then
    chat:AddMessage("|cff66ccffAssistant:|r " .. tostring(message))
  end
end

-- Call a UI method only when loaded; tests may have no UI.
function Core.ui(method, ...)
  local fn = FA.UI and FA.UI[method]
  if type(fn) == "function" then return fn(...) end
end

-- Shared tick: display frames for 0.5 seconds and poll slots on their schedule.
function FA.tick(now)
  now = now or GetTime()
  if FA.Voice and FA.Voice.enabled() then
    FA.Voice.tick(now)
  else
    FA.Outbound.tick(now)
    FA.Inbound.tick(now)
  end
end

if CreateFrame then
  local events = CreateFrame("Frame")
  events:RegisterEvent("PLAYER_LOGIN")
  events:SetScript("OnEvent", function(_, event)
    if event == "PLAYER_LOGIN" then
      FA.Assistant.start()
      if C_Timer and C_Timer.NewTicker then
        C_Timer.NewTicker(0.25, function() FA.tick() end)
      else
        local elapsed = 0
        events:SetScript("OnUpdate", function(_, delta)
          elapsed = elapsed + delta
          if elapsed >= 0.25 then
            elapsed = 0
            FA.tick()
          end
        end)
      end
    end
  end)
end
