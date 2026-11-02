-- Client item information for lookup_items: GetItemInfo and tooltip lines exactly
-- as the player sees them, including stats, DPS and requirements. The Forever client
-- is authoritative. Request uncached items from the server;
-- wait for up to three one-second attempts, then mark not_cached.
local _, FA = ...
local ItemInfo = {}
FA.ItemInfo = ItemInfo

local Json = FA.Json
local NULL = Json.null
local Core = FA.Core

local MAX_LINES = 40
local MAX_TEXT = 1024
local ATTEMPTS = 3
local SCANNER = "ForeverAssistantScanTooltip"

local function getItemInfo()
  return (C_Item and C_Item.GetItemInfo) or GetItemInfo
end

local function text(value)
  if type(value) ~= "string" then return NULL end
  value = string.gsub((string.gsub(value, "|c%x%x%x%x%x%x%x%x", "")), "|r", "")
  if value == "" then return NULL end
  return Core.utf8Truncate(value, MAX_TEXT)
end

local function count(value)
  if type(value) ~= "number" or value < 0 then return NULL end
  return math.floor(value)
end

local function addLine(lines, left, right)
  if #lines >= MAX_LINES then return end
  left, right = text(left), text(right)
  local line
  if left ~= NULL and right ~= NULL then
    line = left .. "    " .. right
  elseif left ~= NULL then
    line = left
  elseif right ~= NULL then
    line = right
  end
  if line then lines[#lines + 1] = Core.utf8Truncate(line, MAX_TEXT) end
end

local scanner
local function scanTooltip(arg, lines)
  if not scanner then
    if not CreateFrame then return end
    scanner = CreateFrame("GameTooltip", SCANNER, nil, "GameTooltipTemplate")
  end
  scanner:SetOwner(WorldFrame or UIParent, "ANCHOR_NONE")
  scanner:ClearLines()
  Core.try(scanner.SetHyperlink, scanner, type(arg) == "string" and arg or ("item:" .. arg))
  local numLines = Core.try(scanner.NumLines, scanner) or 0
  for i = 1, numLines do
    local left, right = _G[SCANNER .. "TextLeft" .. i], _G[SCANNER .. "TextRight" .. i]
    addLine(lines, left and left:GetText(), right and right:IsShown() and right:GetText() or nil)
  end
  scanner:Hide()
end

-- Tooltip lines: use the new tooltip data API, or fall back to a hidden tooltip.
function ItemInfo.tooltip(arg)
  local lines = Json.array()
  local api = C_TooltipInfo
  if type(api) == "table" then
    local data
    if type(arg) == "string" then data = Core.try(api.GetHyperlink, arg) else data = Core.try(api.GetItemByID, arg) end
    if type(data) == "table" and type(data.lines) == "table" then
      for _, line in ipairs(data.lines) do addLine(lines, line.leftText, line.rightText) end
      return lines
    end
  end
  scanTooltip(arg, lines)
  return lines
end

-- One item. The second return value is true if the client does not yet know the item.
function ItemInfo.read(item)
  local link = type(item.itemLink) == "string" and item.itemLink or nil
  local info = {
    item = { itemId = item.itemId, itemLink = link or NULL },
    name = NULL, quality = NULL, itemLevel = NULL, requiredLevel = NULL,
    itemType = NULL, itemSubType = NULL, equipSlot = NULL, sellPriceCopper = NULL,
    tooltip = Json.array(),
    unavailableReason = NULL,
  }
  local get = getItemInfo()
  if type(get) ~= "function" then
    info.unavailableReason = "api_unavailable"
    return info, false
  end
  local arg = link or item.itemId
  local name, _, quality, itemLevel, minLevel, itemType, subType, _, equipLoc, _, sellPrice = Core.try(get, arg)
  if type(name) ~= "string" or name == "" then
    if C_Item and C_Item.RequestLoadItemDataByID then Core.try(C_Item.RequestLoadItemDataByID, item.itemId) end
    info.unavailableReason = "not_cached"
    return info, true
  end
  info.name = text(name)
  if type(quality) == "number" and quality >= 0 and quality <= 10 then info.quality = math.floor(quality) end
  info.itemLevel = count(itemLevel)
  info.requiredLevel = count(minLevel)
  info.itemType = text(itemType)
  info.itemSubType = text(subType)
  info.equipSlot = text(equipLoc)
  info.sellPriceCopper = count(sellPrice)
  info.tooltip = ItemInfo.tooltip(arg)
  return info, false
end

-- All requested items; call done(list) immediately or after the cache loads.
function ItemInfo.collect(items, done)
  local attempt = 0
  local function run()
    attempt = attempt + 1
    local list, missing = Json.array(), false
    for i, item in ipairs(items) do
      local info, notCached = ItemInfo.read(item)
      list[i] = info
      missing = missing or notCached
    end
    if missing and attempt < ATTEMPTS and C_Timer and C_Timer.After then
      C_Timer.After(1, run)
      return
    end
    done(list)
  end
  run()
end
