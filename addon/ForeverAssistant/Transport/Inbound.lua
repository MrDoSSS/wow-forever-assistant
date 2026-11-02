-- Incoming channel: one shared LoD polling timer. Read at 5, 10, 16, 24, 34, 46,
-- 60, 80, 100, 130, 160, 200, 240 and 300 seconds after exchange starts,
-- then every 60 seconds. A late tick performs one read without catch-up bursts.
-- Every read consumes the next unused slot.
local _, FA = ...
local Inbound = {
  running = false,
  startedAt = 0,
  step = 1,
  reads = 0,
  paused = nil,
  nextSlot = 1,
  stats = { reads = 0, packets = 0, empty = 0, failed = 0 },
}
FA.Inbound = Inbound

Inbound.SCHEDULE = { 5, 10, 16, 24, 34, 46, 60, 80, 100, 130, 160, 200, 240, 300 }
Inbound.LOW_SLOT_THRESHOLD = 20

function Inbound.offset(step)
  local schedule = Inbound.SCHEDULE
  if step <= #schedule then return schedule[step] end
  return schedule[#schedule] + 60 * (step - #schedule)
end

function Inbound.slotCount()
  local config = ForeverAssistantConfig
  return (config and tonumber(config.slotCount)) or 200
end

function Inbound.slotName(index)
  return string.format("ForeverAssistant_Slot%03d", index)
end

local function addonApi()
  local api = C_AddOns or {}
  return api.LoadAddOn or LoadAddOn, api.IsAddOnLoaded or IsAddOnLoaded
end

function Inbound.slotsLeft()
  local _, isLoaded = addonApi()
  local left = 0
  for i = Inbound.nextSlot, Inbound.slotCount() do
    if not (isLoaded and isLoaded(Inbound.slotName(i))) then left = left + 1 end
  end
  return left
end

-- Check when starting an exchange and after reading, without extra slot polling.
-- Two notifications per game session: low slots and no slots left.
function Inbound.checkSlots()
  local left = Inbound.slotsLeft()
  FA.Core.ui("setSlotsRemaining", left)
  if left == 0 then
    Inbound.pause("slots_exhausted")
    if Inbound.slotWarningLevel ~= "empty" then
      Inbound.slotWarningLevel = "empty"
      FA.Assistant.onSlotsExhausted("exhausted")
    end
  elseif left <= Inbound.LOW_SLOT_THRESHOLD and not Inbound.slotWarningLevel then
    Inbound.slotWarningLevel = "low"
    FA.Assistant.onSlotsLow(left)
  end
  return left
end

-- Start an exchange only if the timer is off; do not duplicate an active timer.
function Inbound.start(now)
  if Inbound.running then return end
  Inbound.running = true
  Inbound.paused = nil
  Inbound.startedAt = now
  Inbound.step = 1
  Inbound.reads = 0
  Inbound.checkSlots()
end

-- Retry, HELLO or a new question after a pause restarts the schedule.
function Inbound.restart(now)
  Inbound.running = false
  Inbound.start(now)
end

function Inbound.stop()
  Inbound.running = false
  Inbound.paused = nil
end

function Inbound.pause(reason)
  Inbound.paused = reason
end

function Inbound.tick(now)
  if not Inbound.running or Inbound.paused then return end
  local elapsed = now - Inbound.startedAt
  if elapsed < Inbound.offset(Inbound.step) then return end
  repeat
    Inbound.step = Inbound.step + 1
  until Inbound.offset(Inbound.step) > elapsed
  Inbound.readOnce()
  FA.Assistant.afterRead(now)
end

-- Load the next slot and apply its packet. Empty reads also consume slots.
function Inbound.readOnce()
  local loadAddOn, isLoaded = addonApi()
  if not loadAddOn then
    Inbound.stats.failed = Inbound.stats.failed + 1
    FA.Assistant.onSlotsExhausted("api_unavailable")
    return
  end
  local count = Inbound.slotCount()
  while Inbound.nextSlot <= count and isLoaded and isLoaded(Inbound.slotName(Inbound.nextSlot)) do
    Inbound.nextSlot = Inbound.nextSlot + 1
  end
  if Inbound.nextSlot > count then
    Inbound.checkSlots()
    return
  end
  local name = Inbound.slotName(Inbound.nextSlot)
  Inbound.nextSlot = Inbound.nextSlot + 1
  Inbound.reads = Inbound.reads + 1
  Inbound.stats.reads = Inbound.stats.reads + 1
  ForeverAssistantInbox = nil
  local ok, loaded, reason = pcall(loadAddOn, name)
  local packet = ForeverAssistantInbox
  ForeverAssistantInbox = nil
  if not ok or not loaded then
    Inbound.stats.failed = Inbound.stats.failed + 1
    FA.Assistant.onSlotFailed(name, ok and tostring(reason) or "error")
    Inbound.checkSlots()
    return
  end
  if type(packet) ~= "table" then
    Inbound.stats.empty = Inbound.stats.empty + 1
    Inbound.checkSlots()
    return
  end
  Inbound.stats.packets = Inbound.stats.packets + 1
  FA.Assistant.applyPacket(packet)
  Inbound.checkSlots()
end
