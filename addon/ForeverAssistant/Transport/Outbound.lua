-- Outgoing channel: queue up to eight messages; display each frame for 0.5 seconds;
-- interleave one fragment per message until each whole message is acknowledged.
-- A new CANCEL gets the next frame. Hide the field while idle.
local _, FA = ...
local Outbound = {
  queue = {},
  cursor = 0,
  suspended = false,
  shownAt = nil,
  urgent = nil,
  lastCells = nil,
  lastShown = nil,
}
FA.Outbound = Outbound

Outbound.MAX_QUEUE = 8
Outbound.FRAME_SECONDS = 0.5

-- Persist the queue in character SavedVariables so /reload retries preserve
-- the original originSessionId, sequence number and message bytes.
function Outbound.attach(queue)
  Outbound.queue = queue
  Outbound.cursor = 0
  Outbound.urgent = nil
end

function Outbound.enqueue(item, urgent)
  if #Outbound.queue >= Outbound.MAX_QUEUE then return false end
  item.next = item.next or 0
  item.fragments = FA.Codec.fragmentCount(#item.bytes)
  table.insert(Outbound.queue, item)
  if urgent then
    Outbound.urgent = item
    Outbound.shownAt = nil
  end
  return true
end

function Outbound.find(origin, sequence)
  for i, item in ipairs(Outbound.queue) do
    if item.origin == origin and item.sequence == sequence then return item, i end
  end
end

function Outbound.ack(origin, sequence)
  local item, index = Outbound.find(origin, sequence)
  if not item then return nil end
  table.remove(Outbound.queue, index)
  if Outbound.urgent == item then Outbound.urgent = nil end
  if Outbound.cursor >= index then Outbound.cursor = Outbound.cursor - 1 end
  return item
end

function Outbound.hasPending()
  return #Outbound.queue > 0
end

-- Field origin: client TOPLEFT + 8 physical pixels; one UI unit equals one pixel.
local field, textures

-- Compute fragment cells once so redisplaying the same frame is inexpensive.
local cellCache = setmetatable({}, { __mode = "k" })

local function cellsFor(item, index)
  local cached = cellCache[item]
  if not cached then
    cached = {}
    cellCache[item] = cached
  end
  if not cached[index] then cached[index] = FA.Codec.cells(FA.Codec.frameBytes(item, index)) end
  return cached[index]
end

local function physicalHeight()
  if GetPhysicalScreenSize then
    local _, height = GetPhysicalScreenSize()
    if type(height) == "number" and height > 0 then return height end
  end
  local resolution = GetCVar and (GetCVar("gxWindowedResolution") or GetCVar("gxResolution"))
  local height = resolution and tonumber(string.match(resolution, "%d+x(%d+)"))
  return height
end

local function ensureField()
  if field then return field end
  local height = physicalHeight()
  if not height then
    Outbound.fieldError = "physical_height_unknown"
    return nil
  end
  local Codec = FA.Codec
  field = CreateFrame("Frame", "ForeverAssistantField", UIParent)
  field:SetFrameStrata("TOOLTIP")
  if field.SetIgnoreParentScale then
    field:SetIgnoreParentScale(true)
    field:SetScale(768 / height)
  else
    field:SetScale(768 / height / UIParent:GetEffectiveScale())
  end
  field:SetSize(Codec.COLS * Codec.CELL, Codec.ROWS * Codec.CELL)
  field:SetPoint("TOPLEFT", UIParent, "TOPLEFT", Codec.OFFSET, -Codec.OFFSET)
  textures = {}
  for i = 0, Codec.COLS * Codec.ROWS - 1 do
    local texture = field:CreateTexture(nil, "OVERLAY")
    texture:SetSize(Codec.CELL, Codec.CELL)
    texture:SetPoint("TOPLEFT", field, "TOPLEFT", (i % Codec.COLS) * Codec.CELL, -math.floor(i / Codec.COLS) * Codec.CELL)
    if texture.SetSnapToPixelGrid then texture:SetSnapToPixelGrid(false) end
    if texture.SetTexelSnappingBias then texture:SetTexelSnappingBias(0) end
    textures[i + 1] = texture
  end
  field:Hide()
  return field
end

local function render(cells)
  if not ensureField() then return end
  local Codec = FA.Codec
  for i = 1, #cells do
    local r, g, b = Codec.cellColor(cells[i])
    local texture = textures[i]
    if texture.SetColorTexture then
      texture:SetColorTexture(r, g, b, 1)
    else
      texture:SetTexture(r, g, b, 1)
    end
  end
  field:Show()
end

function Outbound.hide()
  if field then field:Hide() end
  Outbound.lastShown = nil
end

local function pick()
  if Outbound.urgent and Outbound.find(Outbound.urgent.origin, Outbound.urgent.sequence) then
    local item = Outbound.urgent
    if item.next + 1 >= item.fragments then Outbound.urgent = nil end
    return item
  end
  Outbound.urgent = nil
  Outbound.cursor = Outbound.cursor % #Outbound.queue + 1
  return Outbound.queue[Outbound.cursor]
end

-- Select bytes independently of rendering so the silent channel reuses retries
-- and ACK handling without creating the field or its textures.
function Outbound.nextFrame(now)
  if Outbound.suspended or #Outbound.queue == 0 then
    return nil
  end
  if Outbound.shownAt and now - Outbound.shownAt < Outbound.FRAME_SECONDS then return nil end
  local item = pick()
  local index = item.next
  item.next = (item.next + 1) % item.fragments
  Outbound.lastShown = { origin = item.origin, sequence = item.sequence, index = index }
  Outbound.shownAt = now
  return item, index
end

function Outbound.tick(now)
  if FA.Voice and FA.Voice.enabled() then Outbound.hide(); return end
  if Outbound.suspended or #Outbound.queue == 0 then Outbound.hide(); return end
  local item, index = Outbound.nextFrame(now)
  if not item then return end
  local cells = cellsFor(item, index)
  Outbound.lastCells = cells
  render(cells)
end
