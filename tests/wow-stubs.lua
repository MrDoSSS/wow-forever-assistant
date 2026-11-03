-- Fake WoW API for running the addon in fengari. Tests control values
-- through WowStub. This is not a client simulation; verify real API behavior in the game.
WowStub = {
  time = 1000.0,
  guid = "Player-1-00000001",
  realm = "Forever",
  name = "Tester",
  loaded = {},
  inbox = nil,      -- Inbox.lua source returned by the next LoadAddOn
  loads = {},       -- loaded slot names in order
  missingSlots = {},
  popupCalls = {},
}

local function noop() end

local function object(kind, name, parent)
  local obj = { kind = kind, name = name, parent = parent, shown = true, enabled = true, text = "", scripts = {}, children = {} }
  local methods = {}
  function methods.Show(self)
    local changed = not self.shown; self.shown = true
    if changed and self.scripts.OnShow then self.scripts.OnShow(self) end
  end
  function methods.Hide(self)
    local changed = self.shown; self.shown = false
    if changed and self.scripts.OnHide then self.scripts.OnHide(self) end
  end
  function methods.IsShown(self) return self.shown end
  function methods.IsVisible(self) return self.shown and (not self.parent or self.parent:IsVisible()) end
  function methods.SetScript(self, event, fn) self.scripts[event] = fn end
  function methods.GetScript(self, event) return self.scripts[event] end
  function methods.CreateTexture(self)
    local texture = object("Texture")
    table.insert(self.children, texture)
    return texture
  end
  function methods.CreateFontString(self)
    local label = object("FontString", nil, self)
    table.insert(self.children, label)
    return label
  end
  function methods.SetColorTexture(self, r, g, b, a) self.color = { r, g, b, a } end
  function methods.SetPoint(self, point, relative, relativePoint, x, y)
    if type(relative) == "number" then x, y, relative, relativePoint = relative, relativePoint, self.parent, point end
    self.point = { point, x or 0, y or 0 }
    self.anchor = { point, relative or self.parent, relativePoint or point, x or 0, y or 0 }
  end
  function methods.GetPoint(self) return table.unpack(self.anchor or { "CENTER", UIParent, "CENTER", 0, 0 }) end
  function methods.SetScale(self, scale) self.scale = scale end
  function methods.SetSize(self, width, height) self.width, self.height = width, height end
  function methods.SetWidth(self, width) self.width = width end
  function methods.SetHeight(self, height) self.height = height end
  function methods.GetWidth(self) return self.width or (self.parent and self.parent:GetWidth()) or 1024 end
  function methods.GetHeight(self) return self.height or (self.parent and self.parent:GetHeight()) or 768 end
  function methods.GetFrameLevel() return 1 end
  function methods.SetFont(self, path, size, flags)
    if WowStub.fontUnavailable == path then return false end
    self.font = { path, size, flags }
    return true
  end
  function methods.GetFont(self) return table.unpack(self.font or { "Fonts\\FRIZQT__.TTF", 14, "" }) end
  function methods.GetText(self) return self.text end
  function methods.SetText(self, text) self.text = text; if self.scripts.OnTextChanged then self.scripts.OnTextChanged(self) end end
  function methods.Insert(self, text) self:SetText(self.text .. text) end
  function methods.SetChecked(self, checked) self.checked = checked end
  function methods.GetChecked(self) return self.checked end
  function methods.Enable(self) self.enabled = true end
  function methods.Disable(self) self.enabled = false end
  function methods.SetFocus(self) self.focused = true end
  function methods.ClearFocus(self) self.focused = false end
  function methods.HasFocus(self) return self.focused end
  function methods.AtBottom() return true end
  function methods.GetEffectiveScale() return 1 end
  return setmetatable(obj, {
    __index = function(_, key)
      return methods[key] or (string.match(key, "^[A-Z]") and noop or nil)
    end,
  })
end

UIParent = object("Frame", "UIParent")
function CreateFrame(kind, name, parent)
  local frame = object(kind, name, parent)
  if parent then table.insert(parent.children, frame) end
  if name then _G[name] = frame end
  return frame
end

GameFontHighlight = object("Font")
UISpecialFrames, SlashCmdList, StaticPopupDialogs = {}, {}, {}
tinsert = table.insert
function StaticPopup_Show(name, text1, text2, data)
  WowStub.popup, WowStub.popupData = name, data
  table.insert(WowStub.popupCalls, { name = name, text = text1, data = data })
end
function StaticPopup_Hide(name) if WowStub.popup == name then WowStub.popup = nil end end
function ReloadUI() WowStub.reloads = (WowStub.reloads or 0) + 1 end
WowStub.bindings = {}
function GetBindingKey(action)
  local keys = {}
  for key, value in pairs(WowStub.bindings) do if value == action then keys[#keys + 1] = key end end
  table.sort(keys)
  return table.unpack(keys)
end
function GetBindingAction(key) return WowStub.bindings[key] or "" end
function SetBinding(key, action) WowStub.bindings[key] = action; return true end
function GetCurrentBindingSet() return 2 end
function SaveBindings(set) WowStub.savedBindingSet = set end
function InCombatLockdown() return WowStub.combat or false end

function GetTime() return WowStub.time end
function GetPhysicalScreenSize() return 2560, 1440 end
function UnitGUID(unit) if unit == "player" then return WowStub.guid end end
function GetRealmName() return WowStub.realm end
function UnitName(unit) if unit == "player" then return WowStub.name, WowStub.surname end end
function UnitClass() return "Mage", "MAGE", 8 end
function UnitRace() return "Human", "Human", 1 end
function UnitLevel() return 12 end
function UnitFactionGroup() return "Alliance", "Alliance" end
function GetMoney() return 12345 end
-- Client language: WowStub.locale, with zone and map names from WowStub.zoneText and WowStub.mapNames.
function GetLocale() return WowStub.locale or "enUS" end
function GetZoneText() return WowStub.zoneText or "Elwynn Forest" end
STANDARD_TEXT_FONT = STANDARD_TEXT_FONT or "Fonts\\FRIZQT__.TTF"

local equipment = {
  [1] = { id = 7046, link = "|cff1eff00|Hitem:7046::::::::12:::::::|h[Azure Silk Hood]|h|r" },
  [16] = { id = 2132, link = nil }, -- item whose link is not cached
}
function GetInventoryItemID(_, slot) return equipment[slot] and equipment[slot].id end
function GetInventoryItemLink(_, slot) return equipment[slot] and equipment[slot].link end

C_Container = {
  GetContainerNumSlots = function(bag) if bag == 0 then return 16 end return 0 end,
  GetContainerItemInfo = function(bag, slot)
    if bag == 0 and slot == 1 then
      return { itemID = 118, stackCount = 2, hyperlink = "|cffffffff|Hitem:118::::::::12:::::::|h[Minor Healing Potion]|h|r" }
    end
    if bag == 0 and slot == 2 then return { itemID = 159, stackCount = 5, hyperlink = nil } end
  end,
}

C_QuestLog = {
  GetNumQuestLogEntries = function() return 2, 1 end,
  GetInfo = function(i)
    if i == 1 then return { title = "Elwynn Forest", isHeader = true } end
    if i == 2 then return { title = "Wolves in the forest", questID = 33, isHeader = false } end
  end,
  GetQuestObjectives = function() return { { text = "Wolves slain: 3/8", finished = false, numFulfilled = 3, numRequired = 8 } } end,
  IsComplete = function() return false end,
}

function GetNumTalentTabs() return 1 end
function GetNumTalents() return 2 end
function GetTalentInfo(_, index)
  if index == 1 then return "Improved Fireball", nil, 1, 1, 2, 5 end
  return "Impact", nil, 1, 2, 0, 5
end

local skills = {
  { "\208\159\209\128\208\190\209\132\208\181\209\129\209\129\208\184\208\184", true, true },
  { "\208\159\208\190\209\128\209\130\208\189\209\143\208\182\208\189\208\190\208\181 \208\180\208\181\208\187\208\190", false, nil, 75, 0, 0, 150 },
  { "\208\175\208\183\209\139\208\186\208\184", true, true },
  { "\208\146\209\129\208\181\208\190\208\177\209\137\208\184\208\185", false, nil, 300, 0, 0, 300 },
}
function GetNumSkillLines() return #skills end
function GetSkillLineInfo(i) return table.unpack(skills[i]) end

C_Map = {
  GetBestMapForUnit = function() return 1429 end,
  GetPlayerMapPosition = function() return { x = 0.4123, y = 0.6501 } end,
}

C_AddOns = {
  LoadAddOn = function(name)
    if WowStub.missingSlots[name] then return false, "MISSING" end
    if WowStub.loaded[name] then return true end
    WowStub.loaded[name] = true
    table.insert(WowStub.loads, name)
    if WowStub.inbox then
      local chunk = assert(load(WowStub.inbox, "=" .. name))
      chunk()
    end
    return true
  end,
  IsAddOnLoaded = function(name) return WowStub.loaded[name] == true end,
}

ForeverAssistantConfig = { serverNamespace = "forever-test", slotCount = 200 }

-- Items, Auctionator and maps. Auctionator is not installed by default.
local itemNames = { [118] = "Minor Healing Potion", [7046] = "Azure Silk Hood" }
local itemDetails = {
  [7046] = { 2, 22, 17, "Armor", "Cloth", "INVTYPE_HEAD", 512 },
  [118] = { 1, 5, 1, "Consumable", "Potion", "", 1 },
}
function GetItemInfo(arg)
  local id = type(arg) == "number" and arg or tonumber(string.match(arg, "Hitem:(%d+)"))
  local name = itemNames[id]
  if not name then return nil end
  local d = itemDetails[id] or {}
  return name, "|cffffffff|Hitem:" .. id .. "::::::::12:::::::|h[" .. name .. "]|h|r", d[1], d[2], d[3], d[4], d[5], 1, d[6], 0, d[7]
end

WowStub.cacheRequests = {}
C_Item = { RequestLoadItemDataByID = function(id) table.insert(WowStub.cacheRequests, id) end }
C_TooltipInfo = {
  GetItemByID = function(id) return C_TooltipInfo.lines(id) end,
  GetHyperlink = function(link) return C_TooltipInfo.lines(tonumber(string.match(link, "Hitem:(%d+)"))) end,
  lines = function(id)
    if id ~= 7046 then return nil end
    return { lines = {
      { leftText = "Azure Silk Hood" },
      { leftText = "Head", rightText = "Cloth" },
      { leftText = "|cffffffff14 Armor|r" },
      { leftText = "" },
      { leftText = "Requires Level 17" },
    } }
  end,
}

-- prices maps itemId to copper. Resolve links by ID; link exactness is false for the base key.
function WowStubAuctionator(prices)
  Auctionator = { Database = {}, State = { CurrentRealm = "Forever Alliance" }, API = { v1 = {} } }
  local v1 = Auctionator.API.v1
  local function check(caller) if type(caller) ~= "string" or caller == "" then error("Invalid callerID") end end
  local function linkId(link) return tonumber(string.match(link, "Hitem:(%d+)")) end
  v1.GetAuctionPriceByItemID = function(caller, id) check(caller); return prices[id] end
  v1.GetAuctionPriceByItemLink = function(caller, link) check(caller); return prices[linkId(link)] end
  v1.GetAuctionAgeByItemID = function(caller, id) check(caller); if prices[id] then return 2 end end
  v1.GetAuctionAgeByItemLink = function(caller, link) check(caller); if prices[linkId(link)] then return 2 end end
  v1.IsAuctionDataExactByItemID = function(caller, id) check(caller); return prices[id] ~= nil end
  v1.IsAuctionDataExactByItemLink = function(caller) check(caller); return false end
end

C_AddOns.GetAddOnMetadata = function(name, field)
  if name == "Auctionator" and field == "Version" and Auctionator then return "341" end
end

local maps = {
  [1415] = { name = "Eastern Kingdoms", mapType = 2, parentMapID = 947 },
  [1420] = { name = "Tirisfal Glades", mapType = 3, parentMapID = 1415 },
  [1429] = { name = "Elwynn Forest", mapType = 3, parentMapID = 1415 },
  [1458] = { name = "Undercity", mapType = 3, parentMapID = 1420 },
  [2000] = { name = "Undercity", mapType = 4 }, -- prefer the zone over the same-named dungeon
}
C_Map.GetMapInfo = function(id)
  local info, name = maps[id], WowStub.mapNames and WowStub.mapNames[id]
  if info and name then return { name = name, mapType = info.mapType, parentMapID = info.parentMapID } end
  return info
end

-- World coordinates: map rectangle on continent 0 (left, top, width, height).
local world = {
  [1415] = { 0, 0, 1000, 1000 },
  [1420] = { 300, 100, 200, 150 },
  [1429] = { 400, 800, 150, 100 },
  [1458] = { 410, 160, 20, 20 },
}
function CreateVector2D(x, y)
  return { x = x, y = y, GetXY = function(self) return self.x, self.y end }
end
C_Map.GetWorldPosFromMapPos = function(id, position)
  local r = world[id]
  if r then return 0, CreateVector2D(r[1] + position.x * r[3], r[2] + position.y * r[4]) end
end
C_Map.GetMapPosFromWorldPos = function(_, position, target)
  local r = world[target]
  if r then return target, CreateVector2D((position.x - r[1]) / r[3], (position.y - r[2]) / r[4]) end
end

-- Built-in waypoint: forbidden by the client in cities such as Undercity.
WowStub.waypoint, WowStub.superTracked = nil, nil
UiMapPoint = { CreateFromCoordinates = function(id, x, y) return { uiMapID = id, x = x, y = y } end }
C_Map.CanSetUserWaypointOnMap = function(id) return id ~= 1458 end
C_Map.SetUserWaypoint = function(point) WowStub.waypoint = point end
C_Map.ClearUserWaypoint = function() WowStub.waypoint = nil end
C_SuperTrack = { SetSuperTrackedUserWaypoint = function(on) WowStub.superTracked = on end }

function hooksecurefunc(target, name, fn)
  if type(target) == "string" then target, name, fn = _G, target, name end
  local original = target[name]
  target[name] = function(...)
    local results = { original(...) }
    fn(...)
    return (table.unpack or unpack)(results)
  end
end

WowStub.worldMap = nil
WorldMapFrame = CreateFrame("Frame", "WorldMapFrame")
WorldMapFrame.ScrollContainer = { Child = CreateFrame("Frame") }
WorldMapFrame.ScrollContainer.Child.GetWidth = function() return 1000 end
WorldMapFrame.ScrollContainer.Child.GetHeight = function() return 500 end
function WorldMapFrame.GetMapID() return WowStub.worldMap end
function WorldMapFrame.SetMapID(_, id) WowStub.worldMap = id end
function WorldMapFrame.OnMapChanged() end
function OpenWorldMap(id) WowStub.worldMap = id end

-- Active plan: item counts, learned recipes and the send-mail window.
-- Record mail attachments in WowStub.mail.
WowStub.knownSpells = {}
function IsPlayerSpell(id) return WowStub.knownSpells[id] == true end
function GetItemCount(id)
  local total = 0
  for slot = 1, C_Container.GetContainerNumSlots(0) do
    local info = C_Container.GetContainerItemInfo(0, slot)
    if info and info.itemID == id then total = total + info.stackCount end
  end
  return total
end
WowStub.mail = { attachments = {} }
C_Container.PickupContainerItem = function(bag, slot)
  local info = C_Container.GetContainerItemInfo(bag, slot)
  WowStub.mail.cursor = info and { itemId = info.itemID, count = info.stackCount }
end
C_Container.SplitContainerItem = function(bag, slot, count)
  local info = C_Container.GetContainerItemInfo(bag, slot)
  WowStub.mail.cursor = info and { itemId = info.itemID, count = count }
end
function ClickSendMailItemButton()
  if WowStub.mail.cursor then table.insert(WowStub.mail.attachments, WowStub.mail.cursor); WowStub.mail.cursor = nil end
end
function ClearSendMail() WowStub.mail.attachments, WowStub.mail.money = {}, nil end
SendMailNameEditBox = CreateFrame("EditBox", "SendMailNameEditBox")
SendMailSubjectEditBox = CreateFrame("EditBox", "SendMailSubjectEditBox")
SendMailMoney = CreateFrame("Frame", "SendMailMoney")
function MoneyInputFrame_SetCopper(_, copper) WowStub.mail.money = copper end
