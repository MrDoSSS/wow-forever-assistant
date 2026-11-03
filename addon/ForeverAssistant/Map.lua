-- Map points: one player-selected active point. A verified point
-- uses mapKey "uiMap:<id>" with 0..1 fractions; an unverified point uses a zone
-- name and 0..100 percentages. Find the zone among client maps by name;
-- if absent, display text only. Do not activate a navigation arrow; draw
-- our own marker on the world map when the point's map is visible.
local _, FA = ...
local Map = {}
FA.Map = Map

local Core = FA.Core

local MAX_MAP_ID = 3000
local ZONE_TYPE = 3      -- Enum.UIMapType.Zone
local CONTINENT_TYPE = 2 -- Enum.UIMapType.Continent

Map.REASONS = {
  no_point = "This answer has no map point.",
  no_map = "The zone was not found on your client's map: use the coordinates in the text.",
  no_world_map = "The world map is not available.",
  no_waypoint_api = "This client has no built-in waypoints: use the map mark.",
  waypoint_refused = "The client does not allow a waypoint here: use the map mark.",
}

local index -- normalized name -> { id, rank }
Map.active = nil

local function normalize(name)
  return (string.gsub(string.gsub(string.lower(name), "%s+", " "), "^%s*(.-)%s*$", "%1"))
end

local function buildIndex()
  index = {}
  if not (C_Map and C_Map.GetMapInfo) then return end
  local zone = Enum and Enum.UIMapType and Enum.UIMapType.Zone or ZONE_TYPE
  local continent = Enum and Enum.UIMapType and Enum.UIMapType.Continent or CONTINENT_TYPE
  for id = 1, MAX_MAP_ID do
    local info = Core.try(C_Map.GetMapInfo, id)
    if type(info) == "table" and type(info.name) == "string" and info.name ~= "" then
      -- Prefer zones and continents over same-named dungeon or micro maps.
      local rank = info.mapType == zone and 0 or (info.mapType == continent and 1 or 2)
      local key = normalize(info.name)
      local current = index[key]
      if not current or rank < current.rank or (rank == current.rank and id < current.id) then
        index[key] = { id = id, rank = rank }
      end
    end
  end
end

function Map.zoneMapId(zoneName)
  if type(zoneName) ~= "string" or zoneName == "" then return nil end
  if not index then buildIndex() end
  local hit = index[normalize(zoneName)]
  return hit and hit.id or nil
end

local function unit(value)
  return type(value) == "number" and value >= 0 and value <= 1
end

-- Labels also appear in tooltips drawn with the client's own font: Latin-1 and common
-- punctuation everywhere, plus the script of the client's language.
local LATIN = { { 0x20, 0x7E }, { 0xA0, 0x17F }, { 0x2013, 0x2014 }, { 0x2018, 0x201E }, { 0x2026, 0x2026 } }
local CJK = { { 0x3000, 0x30FF }, { 0x3400, 0x4DBF }, { 0x4E00, 0x9FFF }, { 0xF900, 0xFAFF }, { 0xFF00, 0xFFEF } }
local HANGUL = { { 0x1100, 0x11FF }, { 0x3130, 0x318F }, { 0xAC00, 0xD7A3 } }
local CLIENT_SCRIPTS = {
  ruRU = { { { 0x400, 0x4FF } } },
  koKR = { HANGUL, CJK },
  zhCN = { CJK },
  zhTW = { CJK },
}
local LEAD_BITS = { [2] = 32, [3] = 16, [4] = 8 }

local function covered(code, ranges)
  for _, range in ipairs(ranges) do
    if code >= range[1] and code <= range[2] then return true end
  end
  return false
end

-- True if the client's font of this locale draws every UTF-8 character of text.
function Map.clientFontDraws(text)
  local scripts, length = CLIENT_SCRIPTS[Core.locale()] or {}, 0
  for char in string.gmatch(text, "[\1-\127\194-\244][\128-\191]*") do
    length = length + #char
    local code = string.byte(char, 1)
    if #char > 1 then
      if not LEAD_BITS[#char] then return false end
      code = code % LEAD_BITS[#char]
      for i = 2, #char do code = code * 64 + string.byte(char, i) % 64 end
    end
    local drawn = covered(code, LATIN)
    for _, ranges in ipairs(scripts) do drawn = drawn or covered(code, ranges) end
    if not drawn then return false end
  end
  return length == #text
end

-- The model supplies the point label; omit one the client's font cannot draw.
local function titleOf(value)
  if type(value) == "string" and value ~= "" and Map.clientFontDraws(value) then return value end
  return nil
end

-- The index selects one locations entry; legacy replies contain a single point.
function Map.pointOf(entry, pointIndex)
  if type(entry) ~= "table" then return nil end
  pointIndex = pointIndex or 1
  if type(pointIndex) ~= "number" or pointIndex < 1 or pointIndex ~= math.floor(pointIndex) then return nil end
  if type(entry.locations) == "table" and #entry.locations > 0 then
    entry = entry.locations[pointIndex]
    if type(entry) ~= "table" then return nil end
  elseif pointIndex ~= 1 then
    return nil
  end
  local ref = entry.locationRef
  if type(ref) == "table" then
    local id = tonumber(string.match(tostring(ref.mapKey), "^uiMap:(%d+)$"))
    if not id or not unit(ref.x) or not unit(ref.y) then return nil end
    local info = C_Map and Core.try(C_Map.GetMapInfo, id)
    local zoneName = type(info) == "table" and info.name or ref.mapKey
    return { mapId = id, x = ref.x, y = ref.y, zoneName = zoneName, title = titleOf(ref.title), verified = true, basis = ref.basis }
  end
  local approx = entry.approxLocation
  if type(approx) == "table" and type(approx.x) == "number" and type(approx.y) == "number" then
    -- Reject coordinates outside 0..100 without clamping.
    if approx.x < 0 or approx.x > 100 or approx.y < 0 or approx.y > 100 then return nil end
    -- The bridge sends the uiMapID of an English zone name, which a client in another
    -- language could not match by name; older replies have only the name.
    local id = tonumber(approx.uiMapId)
    local info = id and C_Map and Core.try(C_Map.GetMapInfo, id)
    if type(info) ~= "table" then id, info = Map.zoneMapId(approx.zoneName), nil end
    return {
      mapId = id,
      x = approx.x / 100,
      y = approx.y / 100,
      zoneName = type(info) == "table" and type(info.name) == "string" and info.name or tostring(approx.zoneName),
      title = titleOf(approx.title),
      verified = false,
      basis = approx.basis,
      source = approx.sourceUrl,
    }
  end
  return nil
end

function Map.describe(point)
  return string.format("%s %.1f, %.1f", point.zoneName, point.x * 100, point.y * 100)
end

-- Point label: NPC or place, then zone and coordinates.
function Map.label(point)
  if point.title then return point.title .. " (" .. Map.describe(point) .. ")" end
  return Map.describe(point)
end

-- Source line of a point: the packaged references by name, a web page by its address.
function Map.sourceLabel(point)
  local url = point.source
  if type(url) ~= "string" or url == "" then return nil end
  local lower = string.lower(url)
  if string.find(lower, "foreverdb.net", 1, true) then return "ForeverDB" end
  if string.find(lower, "github.com/questie/questiedb", 1, true) then return "QuestieDB" end
  return url
end

function Map.pointForEntry(entryId, pointIndex)
  if entryId == "plan" then return Map.pointOf(FA.Plan.active(), pointIndex) end
  local state = FA.Assistant.state
  for _, entry in ipairs(state and state.history or {}) do
    if entry.entryId == entryId then return Map.pointOf(entry, pointIndex) end
  end
  return nil
end

local function inside(x, y)
  return type(x) == "number" and type(y) == "number" and x >= 0 and x <= 1 and y >= 0 and y <= 1
end

local function xyOf(vector)
  if type(vector) ~= "table" then return nil end
  if vector.GetXY then return vector:GetXY() end
  return vector.x, vector.y
end

-- Point coordinates on another map (parent zone or continent): transform using
-- client world coordinates or the child map rectangle; nil if the point is outside it.
function Map.project(point, mapId)
  if mapId == point.mapId then return point.x, point.y end
  if type(mapId) ~= "number" or not C_Map then return nil end
  if C_Map.GetWorldPosFromMapPos and C_Map.GetMapPosFromWorldPos and CreateVector2D then
    local continent, world = Core.try(C_Map.GetWorldPosFromMapPos, point.mapId, CreateVector2D(point.x, point.y))
    if continent and world then
      local _, position = Core.try(C_Map.GetMapPosFromWorldPos, continent, world, mapId)
      local x, y = xyOf(position)
      if inside(x, y) then return x, y end
    end
  end
  if C_Map.GetMapRectOnMap then
    local minX, maxX, minY, maxY = Core.try(C_Map.GetMapRectOnMap, point.mapId, mapId)
    if type(minX) == "number" and type(maxX) == "number" and type(minY) == "number" and type(maxY) == "number" and maxX > minX and maxY > minY then
      local x, y = minX + point.x * (maxX - minX), minY + point.y * (maxY - minY)
      if inside(x, y) then return x, y end
    end
  end
  return nil
end

-- World map canvas marker: visible on the point's map and containing maps.
local pin

local function canvas()
  local frame = WorldMapFrame
  return frame and frame.ScrollContainer and frame.ScrollContainer.Child
end

function Map.refreshPin()
  local child = canvas()
  if not child then return end
  local active = Map.active
  if not pin then
    pin = CreateFrame("Frame", nil, child)
    pin:SetSize(24, 24)
    pin.icon = pin:CreateTexture(nil, "OVERLAY")
    pin.icon:SetAllPoints()
    pin:EnableMouse(true)
    pin:SetScript("OnEnter", function(self)
      local point = Map.active
      if not (point and GameTooltip) then return end
      GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
      GameTooltip:AddLine("Assistant: " .. Map.label(point))
      if point.verified then
        GameTooltip:AddLine("Verified", 0.4, 1, 0.4)
      else
        GameTooltip:AddLine("Not verified", 1, 0.5, 0.25)
        local source = Map.sourceLabel(point)
        if source then GameTooltip:AddLine("Source: " .. source, 0.8, 0.8, 0.8, true) end
      end
      GameTooltip:AddLine("/fa map clear removes the mark", 0.6, 0.6, 0.6)
      GameTooltip:Show()
    end)
    pin:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  end
  local shownMap = WorldMapFrame.GetMapID and Core.try(WorldMapFrame.GetMapID, WorldMapFrame)
  local x, y
  if active then x, y = Map.project(active, shownMap) end
  if x then
    -- A star marks a verified point; a diamond marks an unverified point.
    pin.icon:SetTexture(active.verified and "Interface\\TargetingFrame\\UI-RaidTargetingIcon_1" or "Interface\\TargetingFrame\\UI-RaidTargetingIcon_3")
    pin:SetFrameLevel((child.GetFrameLevel and child:GetFrameLevel() or 0) + 100)
    pin:ClearAllPoints()
    pin:SetPoint("CENTER", child, "TOPLEFT", x * child:GetWidth(), -y * child:GetHeight())
    pin:Show()
  else
    pin:Hide()
  end
end

local hooked = false
local function hookWorldMap()
  if hooked or not WorldMapFrame or type(hooksecurefunc) ~= "function" then return end
  hooked = true
  if WorldMapFrame.OnMapChanged then hooksecurefunc(WorldMapFrame, "OnMapChanged", Map.refreshPin) end
  if WorldMapFrame.HookScript then WorldMapFrame:HookScript("OnShow", Map.refreshPin) end
end

local function openWorldMap(mapId)
  -- Opening a panel may be blocked in combat; the marker still appears when the map opens.
  if InCombatLockdown and InCombatLockdown() then return end
  if type(OpenWorldMap) == "function" then
    Core.try(OpenWorldMap, mapId)
  elseif WorldMapFrame then
    if not WorldMapFrame:IsShown() and ShowUIPanel then Core.try(ShowUIPanel, WorldMapFrame) end
    if WorldMapFrame.SetMapID then Core.try(WorldMapFrame.SetMapID, WorldMapFrame, mapId) end
  end
end

-- Player selection: make the entry's point the sole active point.
function Map.show(point)
  if not point then return false, "no_point" end
  if not point.mapId then return false, "no_map" end
  if not canvas() then return false, "no_world_map" end
  Map.active = point
  hookWorldMap()
  openWorldMap(point.mapId)
  Map.refreshPin()
  Core.ui("setStatus", "Map: " .. Map.label(point))
  return true
end

function Map.showEntry(entryId, pointIndex)
  return Map.show(Map.pointForEntry(entryId, pointIndex))
end

-- Player-selected Track: use the built-in client waypoint and tracking
-- for an on-screen distance marker. If the point's map forbids waypoints
-- in a city or dungeon, place it on the nearest allowed parent map.
function Map.track(point)
  if not point then return false, "no_point" end
  if not point.mapId then return false, "no_map" end
  if not (C_Map and C_Map.SetUserWaypoint and UiMapPoint and UiMapPoint.CreateFromCoordinates) then return false, "no_waypoint_api" end
  local mapId, x, y = point.mapId, point.x, point.y
  for _ = 1, 5 do
    local allowed = not C_Map.CanSetUserWaypointOnMap or Core.try(C_Map.CanSetUserWaypointOnMap, mapId)
    if allowed then
      local placed = Core.try(function()
        C_Map.SetUserWaypoint(UiMapPoint.CreateFromCoordinates(mapId, x, y))
        return true
      end)
      if placed then
        if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then Core.try(C_SuperTrack.SetSuperTrackedUserWaypoint, true) end
        Map.active, Map.tracked = point, true
        Map.refreshPin()
        Core.ui("setStatus", "Tracking: " .. Map.label(point))
        return true
      end
    end
    local info = Core.try(C_Map.GetMapInfo, mapId)
    local parent = type(info) == "table" and info.parentMapID
    if type(parent) ~= "number" or parent == 0 then break end
    x, y = Map.project(point, parent)
    if not x then break end
    mapId = parent
  end
  return false, "waypoint_refused"
end

function Map.trackEntry(entryId, pointIndex)
  return Map.track(Map.pointForEntry(entryId, pointIndex))
end

function Map.clear()
  if Map.tracked and C_Map and C_Map.ClearUserWaypoint then
    Core.try(C_Map.ClearUserWaypoint)
    if C_SuperTrack and C_SuperTrack.SetSuperTrackedUserWaypoint then Core.try(C_SuperTrack.SetSuperTrackedUserWaypoint, false) end
  end
  Map.active, Map.tracked = nil, false
  Map.refreshPin()
end

-- Current world map marker, exposed for tests.
function Map.pinFrame()
  return pin
end
