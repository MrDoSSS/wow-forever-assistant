-- Snapshot collectors: eight groups selected by local policy. Missing APIs return
-- unavailable; incomplete data returns partial with a reason. Never replace unknown
-- data with empty results. Verify actual client API support in the game.
local _, FA = ...
local Context = {}
FA.Context = Context

local Json = FA.Json
local NULL = Json.null
local try = FA.Core.try

Context.GROUPS = { "character", "equipment", "quests", "talents", "position", "bags", "professions", "prices" }
Context.LARGE = 4096
local MAX_STRING = 1024

local function text(value, allowEmpty)
  if type(value) ~= "string" then return allowEmpty and "" or nil end
  value = FA.Core.utf8Truncate(value, MAX_STRING)
  if value == "" and not allowEmpty then return nil end
  return value
end

-- Item ID from a full client link: 8-hex classic color or |cnIQ4: quality on newer clients.
function Context.itemLinkId(link)
  if type(link) ~= "string" or #link > MAX_STRING then return nil end
  local id = string.match(link, "^|c%x%x%x%x%x%x%x%x|Hitem:(%d+)[^|]*|h%[[^|]*%]|h|r$")
    or string.match(link, "^|cn[%w_]+:|Hitem:(%d+)[^|]*|h%[[^|]*%]|h|r$")
  return tonumber(id)
end

-- Return only a client item link with the same ID; otherwise null.
function Context.itemInput(itemId, link)
  if type(itemId) ~= "number" or itemId < 1 then return nil end
  local valid = NULL
  if Context.itemLinkId(link) == itemId then valid = link end
  return { itemId = itemId, itemLink = valid }
end

function Context.linkItemId(link)
  if type(link) ~= "string" then return nil end
  return tonumber(string.match(link, "|Hitem:(%d+)"))
end

local FACTIONS = { Alliance = "alliance", Horde = "horde", Neutral = "neutral" }

local collectors = {}

function collectors.character()
  local _, classToken = try(UnitClass, "player")
  local _, raceToken = try(UnitRace, "player")
  local level = try(UnitLevel, "player")
  classToken, raceToken = text(classToken), text(raceToken)
  if not classToken or not raceToken or type(level) ~= "number" or level < 1 then return nil, "not_ready" end
  local money = try(GetMoney)
  return {
    classToken = classToken,
    raceToken = raceToken,
    faction = FACTIONS[try(UnitFactionGroup, "player") or ""] or "unknown",
    level = level,
    moneyCopper = type(money) == "number" and money or NULL,
  }, "complete"
end

function collectors.equipment()
  if not GetInventoryItemID and not GetInventoryItemLink then return nil, "api_unavailable" end
  local list = Json.array()
  for slot = 1, 19 do
    local link = try(GetInventoryItemLink, "player", slot)
    local itemId = try(GetInventoryItemID, "player", slot) or Context.linkItemId(link)
    list[#list + 1] = { slot = slot, item = Context.itemInput(itemId, link) or NULL }
  end
  return list, "complete"
end

local function objectiveCounts(description)
  local have, need = string.match(description or "", "(%d+)%s*/%s*(%d+)")
  return tonumber(have), tonumber(need)
end

function collectors.quests()
  local list = Json.array()
  local seen = {}
  local partial = nil
  local log = C_QuestLog
  if log and log.GetNumQuestLogEntries and log.GetInfo then
    local entries = try(log.GetNumQuestLogEntries) or 0
    for i = 1, entries do
      local info = try(log.GetInfo, i)
      if type(info) == "table" and not info.isHeader and type(info.questID) == "number" and info.questID > 0 and not seen[info.questID] then
        seen[info.questID] = true
        local objectives = Json.array()
        for index, objective in ipairs(try(log.GetQuestObjectives, info.questID) or {}) do
          objectives[#objectives + 1] = {
            index = index,
            text = text(objective.text, true),
            have = type(objective.numFulfilled) == "number" and objective.numFulfilled or NULL,
            need = type(objective.numRequired) == "number" and objective.numRequired or NULL,
            complete = type(objective.finished) == "boolean" and objective.finished or NULL,
          }
        end
        local complete = try(log.IsComplete, info.questID)
        local failed = try(log.IsFailed, info.questID)
        list[#list + 1] = {
          questId = info.questID,
          title = text(info.title, true),
          state = failed and "failed" or (complete and "complete" or "active"),
          objectives = objectives,
        }
      end
    end
  elseif GetNumQuestLogEntries and GetQuestLogTitle then
    local entries = try(GetNumQuestLogEntries) or 0
    for i = 1, entries do
      local title, _, _, isHeader, isCollapsed, isComplete, _, questId = try(GetQuestLogTitle, i)
      if isHeader and isCollapsed then partial = "not_ready" end
      if not isHeader and type(questId) == "number" and questId > 0 and not seen[questId] then
        seen[questId] = true
        local objectives = Json.array()
        for index = 1, try(GetNumQuestLeaderBoards, i) or 0 do
          local description, _, finished = try(GetQuestLogLeaderBoard, index, i)
          local have, need = objectiveCounts(description)
          objectives[#objectives + 1] = {
            index = index,
            text = text(description, true),
            have = have or NULL,
            need = need or NULL,
            complete = (finished == nil) and NULL or (finished and true or false),
          }
        end
        local state = "active"
        if isComplete == 1 or isComplete == true then state = "complete" elseif isComplete == -1 then state = "failed" end
        list[#list + 1] = { questId = questId, title = text(title, true), state = state, objectives = objectives }
      end
    end
  else
    return nil, "api_unavailable"
  end
  return list, partial and "partial" or "complete", partial
end

-- Talents unlock at level 10; below that level, no talents is a complete result.
Context.TALENT_MIN_LEVEL = 10

function collectors.talents()
  local level = try(UnitLevel, "player")
  if type(level) == "number" and level >= 1 and level < Context.TALENT_MIN_LEVEL then return Json.array(), "complete" end
  if not GetNumTalentTabs or not GetTalentInfo then return nil, "api_unavailable" end
  local list = Json.array()
  for tab = 1, try(GetNumTalentTabs) or 0 do
    for index = 1, try(GetNumTalents, tab) or 0 do
      local name, _, _, _, rank, maxRank = try(GetTalentInfo, tab, index)
      if name and type(rank) == "number" and type(maxRank) == "number" and rank <= maxRank then
        list[#list + 1] = { tab = tab, index = index, spellId = NULL, rank = rank, maxRank = maxRank }
      end
    end
  end
  return list, "complete"
end

function collectors.position()
  local zone = text(try(GetZoneText), true)
  local mapKey, x, y = NULL, NULL, NULL
  local map = C_Map
  local mapId = map and try(map.GetBestMapForUnit, "player")
  if type(mapId) == "number" then
    mapKey = "uiMap:" .. mapId
    local position = try(map.GetPlayerMapPosition, mapId, "player")
    if type(position) == "table" then
      local px, py = position.x, position.y
      if (px == nil or py == nil) and position.GetXY then px, py = position:GetXY() end
      if type(px) == "number" and type(py) == "number" and px >= 0 and px <= 1 and py >= 0 and py <= 1 and (px > 0 or py > 0) then
        x, y = px, py
      end
    end
  end
  return { mapKey = mapKey, x = x, y = y, zoneName = zone }, "complete"
end

function collectors.bags()
  local container = C_Container or {}
  local numSlots = container.GetContainerNumSlots or GetContainerNumSlots
  if not numSlots then return nil, "api_unavailable" end
  local list = Json.array()
  local partial = nil
  for bag = 0, 4 do
    for slot = 1, try(numSlots, bag) or 0 do
      local itemId, count, link
      if container.GetContainerItemInfo then
        local info = try(container.GetContainerItemInfo, bag, slot)
        if type(info) == "table" then itemId, count, link = info.itemID, info.stackCount, info.hyperlink end
      elseif GetContainerItemInfo then
        local _, stack, _, _, _, _, hyperlink, _, _, id = try(GetContainerItemInfo, bag, slot)
        itemId, count, link = id, stack, hyperlink
      end
      if itemId or link then
        local item = Context.itemInput(itemId or Context.linkItemId(link), link)
        if item and #list < Context.LARGE then
          list[#list + 1] = { bag = bag, slot = slot, item = item, count = (type(count) == "number" and count >= 1) and count or 1 }
        elseif item then
          partial = "partial_limit"
        else
          partial = partial or "not_ready"
        end
      end
    end
  end
  return list, partial and "partial" or "complete", partial
end

-- GetSkillLineInfo has no skill ID; match profession names in enUS and ruRU.
Context.PROFESSION_SKILLS = {
  Alchemy = 171, Blacksmithing = 164, Enchanting = 333, Engineering = 202, Herbalism = 182,
  Leatherworking = 165, Mining = 186, Skinning = 393, Tailoring = 197, Cooking = 185,
  ["First Aid"] = 129, Fishing = 356,
  ["\208\144\208\187\209\133\208\184\208\188\208\184\209\143"] = 171, ["\208\154\209\131\208\183\208\189\208\181\209\135\208\189\208\190\208\181 \208\180\208\181\208\187\208\190"] = 164, ["\208\157\208\176\208\187\208\190\208\182\208\181\208\189\208\184\208\181 \209\135\208\176\209\128"] = 333, ["\208\152\208\189\208\182\208\181\208\189\208\181\209\128\208\189\208\190\208\181 \208\180\208\181\208\187\208\190"] = 202,
  ["\208\162\209\128\208\176\208\178\208\189\208\184\209\135\208\181\209\129\209\130\208\178\208\190"] = 182, ["\208\154\208\190\208\182\208\181\208\178\208\189\208\184\209\135\208\181\209\129\209\130\208\178\208\190"] = 165, ["\208\147\208\190\209\128\208\189\208\190\208\181 \208\180\208\181\208\187\208\190"] = 186, ["\208\161\208\189\209\143\209\130\208\184\208\181 \209\136\208\186\209\131\209\128"] = 393,
  ["\208\159\208\190\209\128\209\130\208\189\209\143\208\182\208\189\208\190\208\181 \208\180\208\181\208\187\208\190"] = 197, ["\208\154\209\131\208\187\208\184\208\189\208\176\209\128\208\184\209\143"] = 185, ["\208\159\208\181\209\128\208\178\208\176\209\143 \208\191\208\190\208\188\208\190\209\137\209\140"] = 129, ["\208\160\209\139\208\177\208\189\208\176\209\143 \208\187\208\190\208\178\208\187\209\143"] = 356,
}

-- Profession skill IDs distinguish C_SkillInfo rows from weapon and language skills.
local PROFESSION_IDS = {}
for _, skillId in pairs(Context.PROFESSION_SKILLS) do PROFESSION_IDS[skillId] = true end

function collectors.professions()
  local list = Json.array()
  local seen = {}
  local partial = nil
  -- The Forever client has only C_SkillInfo, with one table per skill row and a skillID.
  local skills = C_SkillInfo
  if skills and skills.GetNumSkillLines and skills.GetSkillLineInfo then
    for i = 1, try(skills.GetNumSkillLines) or 0 do
      local line = try(skills.GetSkillLineInfo, i)
      if type(line) == "table" and not line.isHeader and (line.parentSkillLineID or 0) == 0 then
        local skillId, rank, maxRank = line.skillID, line.rank, line.maxRank
        if PROFESSION_IDS[skillId] and not seen[skillId] and type(rank) == "number" and type(maxRank) == "number" and rank <= maxRank then
          seen[skillId] = true
          list[#list + 1] = { skillId = skillId, name = text(line.name) or tostring(skillId), rank = rank, maxRank = maxRank, knownRecipeSpellIds = NULL }
        end
      end
    end
    return list, "complete"
  end
  if not GetNumSkillLines or not GetSkillLineInfo then return nil, "api_unavailable" end
  for i = 1, try(GetNumSkillLines) or 0 do
    local name, isHeader, isExpanded, rank, _, _, maxRank = try(GetSkillLineInfo, i)
    if isHeader and not isExpanded then partial = "not_ready" end
    local skillId = name and Context.PROFESSION_SKILLS[name]
    if not isHeader and skillId and not seen[skillId] and type(rank) == "number" and type(maxRank) == "number" and rank <= maxRank then
      seen[skillId] = true
      list[#list + 1] = { skillId = skillId, name = text(name), rank = rank, maxRank = maxRank, knownRecipeSpellIds = NULL }
    end
  end
  return list, partial and "partial" or "complete", partial
end

-- Auctionator prices for items linked in the question (Integrations/Auctionator.lua).
function collectors.prices(items)
  return FA.Prices.collect(items, FA.Assistant and FA.Assistant.session.origin)
end

local function disabled()
  return { availability = "disabled", coverage = "unknown", observedAtSessionMs = NULL, reason = "user_disabled", value = NULL }
end

local function unavailable(reason)
  if reason ~= "not_ready" then reason = "api_unavailable" end
  return { availability = "unavailable", coverage = "unknown", observedAtSessionMs = NULL, reason = reason, value = NULL }
end

function Context.group(name, enabled, items)
  if not enabled then return disabled() end
  local ok, value, coverage, reason = pcall(collectors[name], items)
  if not ok or value == nil then return unavailable(ok and coverage or nil) end
  if coverage == "partial" then
    return { availability = "available", coverage = "partial", observedAtSessionMs = FA.Core.sessionMs(), reason = reason or "not_ready", value = value }
  end
  return { availability = "available", coverage = "complete", observedAtSessionMs = FA.Core.sessionMs(), reason = NULL, value = value }
end

-- Client functions used by collectors and transport, exposed through /fa api when
-- /run is disabled. true means the function exists.
Context.API_NAMES = {
  "UnitGUID", "GetRealmName", "UnitClass", "UnitRace", "UnitLevel", "GetMoney",
  "GetInventoryItemID", "GetInventoryItemLink",
  "C_QuestLog.GetNumQuestLogEntries", "C_QuestLog.GetInfo", "C_QuestLog.GetQuestObjectives", "GetQuestLogTitle",
  "GetNumTalentTabs", "GetTalentTabInfo", "GetNumTalents", "GetTalentInfo",
  "C_SkillInfo.GetNumSkillLines", "C_SkillInfo.GetSkillLineInfo", "GetNumSkillLines", "GetSkillLineInfo",
  "C_Map.GetBestMapForUnit", "C_Map.GetPlayerMapPosition", "GetZoneText",
  "C_Container.GetContainerNumSlots", "C_Container.GetContainerItemInfo", "GetContainerNumSlots",
  "C_AddOns.LoadAddOn", "LoadAddOn", "GetPhysicalScreenSize", "C_Timer.NewTicker",
  "Auctionator.API.v1.GetAuctionPriceByItemID", "Auctionator.API.v1.GetAuctionPriceByItemLink",
  "C_Map.GetMapInfo", "OpenWorldMap", "WorldMapFrame.SetMapID", "WorldMapFrame.GetMapID",
  "ChatEdit_InsertLink", "SetItemRef", "GetItemInfo", "hooksecurefunc",
  "C_Item.GetItemInfo", "C_Item.RequestLoadItemDataByID", "C_TooltipInfo.GetItemByID", "C_TooltipInfo.GetHyperlink", "C_Timer.After",
  "C_Map.GetWorldPosFromMapPos", "C_Map.GetMapPosFromWorldPos", "C_Map.GetMapRectOnMap", "CreateVector2D",
  "C_Map.SetUserWaypoint", "C_Map.CanSetUserWaypointOnMap", "C_Map.ClearUserWaypoint", "UiMapPoint.CreateFromCoordinates",
  "C_SuperTrack.SetSuperTrackedUserWaypoint",
  -- Alt data (Collectors/Alts.lua): bank, mail and profession windows.
  "GetInboxNumItems", "GetInboxHeaderInfo", "GetInboxItem", "GetInboxItemLink",
  "C_TradeSkillUI.GetAllRecipeIDs", "C_TradeSkillUI.GetRecipeInfo", "C_TradeSkillUI.GetBaseProfessionInfo",
  "C_TradeSkillUI.GetProfessionInfoByRecipeID", "C_TradeSkillUI.IsTradeSkillLinked",
  "GetTradeSkillLine", "GetNumTradeSkills", "GetTradeSkillInfo", "GetTradeSkillRecipeLink",
  "GetCraftDisplaySkillLine", "GetNumCrafts", "GetCraftInfo", "GetCraftItemLink", "GetRealZoneText",
  -- The Forever client lacks the classic talent API; candidate APIs for newer talent systems.
  "GetTalentInfoByID", "GetSpecialization", "GetNumSpecializations", "GetSpecializationInfo",
  "C_SpecializationInfo.GetSpecialization", "C_SpecializationInfo.GetTalentInfo", "C_SpecializationInfo.GetSpecializationInfo",
  "C_ClassTalents.GetActiveConfigID", "C_ClassTalents.GetConfigIDsBySpecID", "C_ClassTalents.GetLastSelectedSavedConfigID",
  "C_Traits.GetConfigInfo", "C_Traits.GetTreeNodes", "C_Traits.GetNodeInfo", "C_Traits.GetEntryInfo", "C_Traits.GetDefinitionInfo",
  "C_Talent.GetTalentInfo", "C_TalentTree.GetTalentInfo",
}

function Context.apiReport()
  local present, missing = {}, {}
  for _, name in ipairs(Context.API_NAMES) do
    local value = _G
    for part in string.gmatch(name, "[^.]+") do
      value = type(value) == "table" and value[part] or nil
    end
    if type(value) == "function" then present[#present + 1] = name else missing[#missing + 1] = name end
  end
  return present, missing
end

-- Group status for /fa api: availability, coverage and record count.
-- available with zero records means successful empty data, such as talents below level 10.
function Context.describe(policy)
  local snapshot = Context.collect(policy or { enabledGroups = Context.GROUPS }, 1)
  local parts = {}
  for _, name in ipairs(Context.GROUPS) do
    local group = snapshot.groups[name]
    local detail
    if group.availability == "available" then
      local count = type(group.value) == "table" and Json.isArray(group.value) and #group.value or nil
      detail = group.coverage .. (count and (", " .. count .. " items") or "")
    else
      detail = tostring(group.reason)
    end
    parts[#parts + 1] = name .. "=" .. group.availability .. " (" .. detail .. ")"
  end
  return table.concat(parts, ", ")
end

-- Immutable snapshot at send time; snapshotId = requestId = messageSequence.
-- items contains question item links for the prices group.
function Context.collect(policy, snapshotId, items)
  local enabled = {}
  for _, name in ipairs(policy.enabledGroups) do enabled[name] = true end
  local groups = {}
  for _, name in ipairs(Context.GROUPS) do
    groups[name] = Context.group(name, enabled[name], items)
  end
  return { snapshotId = snapshotId, capturedAtSessionMs = FA.Core.sessionMs(), groups = groups }
end
