-- Alt data: each character saves its state in
-- ForeverAssistantDB.alts[characterKey], an account SavedVariable. The client writes
-- the file on logout and /reload; the bridge reads it from disk (bridge/src/sources/alts.ts),
-- not through frames. Update summary, equipment, professions and bags on events;
-- bank and mail only while open; recipes while the profession window is open.
-- Each section is a record list without mixed tables.
local _, FA = ...
local Alts = {}
FA.Alts = Alts

local try = FA.Core.try

Alts.VERSION = 1
Alts.DELAY = 0.5

local record       -- current character record
local leaving = false
local bankOpen, mailOpen = false, false
local pending = {}
local scheduled = false

local FACTIONS = { Alliance = "alliance", Horde = "horde", Neutral = "neutral" }

local function now()
  return (time and time()) or 0
end

local function bagIds()
  local ids = {}
  for bag = 0, NUM_TOTAL_EQUIPPED_BAG_SLOTS or NUM_BAG_SLOTS or 4 do ids[#ids + 1] = bag end
  return ids
end

-- Classic bank (container -1 and bank bags) plus newer client bank tabs.
local function bankIds()
  local ids = { BANK_CONTAINER or -1 }
  local first = (NUM_TOTAL_EQUIPPED_BAG_SLOTS or NUM_BAG_SLOTS or 4) + 1
  for bag = first, first + (NUM_BANKBAGSLOTS or 7) - 1 do ids[#ids + 1] = bag end
  if REAGENTBANK_CONTAINER then ids[#ids + 1] = REAGENTBANK_CONTAINER end
  return ids
end

local function slotItem(bag, slot)
  local container = C_Container or {}
  if container.GetContainerItemInfo then
    local info = try(container.GetContainerItemInfo, bag, slot)
    if type(info) == "table" then return info.itemID, info.stackCount end
    return nil
  end
  if GetContainerItemInfo then
    local _, count, _, _, _, _, _, _, _, itemId = try(GetContainerItemInfo, bag, slot)
    return itemId, count
  end
end

-- Item counts as { itemId, count } sorted by itemId; slots is the total slot count.
local function countItems(ids)
  local numSlots = (C_Container and C_Container.GetContainerNumSlots) or GetContainerNumSlots
  if not numSlots then return nil, 0 end
  local counts, slots = {}, 0
  for _, bag in ipairs(ids) do
    local size = try(numSlots, bag) or 0
    slots = slots + size
    for slot = 1, size do
      local itemId, count = slotItem(bag, slot)
      if type(itemId) == "number" and itemId > 0 then
        counts[itemId] = (counts[itemId] or 0) + ((type(count) == "number" and count >= 1) and count or 1)
      end
    end
  end
  local list = {}
  for itemId, count in pairs(counts) do list[#list + 1] = { itemId = itemId, count = count } end
  table.sort(list, function(a, b) return a.itemId < b.itemId end)
  return list, slots
end

local readers = {}

-- Mail name. In Forever, UnitName's second value is a surname, and mail goes to
-- "Name Surname"; other clients return a realm as the second value, or nil for the player.
function Alts.fullName()
  local name, second = try(UnitNameUnmodified or UnitName, "player")
  if type(name) ~= "string" or name == "" then return nil end
  if type(second) ~= "string" or second == "" then return name end
  local realm = try(GetRealmName)
  if second == realm or second == try(GetNormalizedRealmName) or (realm and second == realm:gsub("[%s%-]", "")) then return name end
  local consts = Constants and Constants.CharacterNameSeparatorConsts
  local separator = consts and consts.CHARACTERNAME_SURNAME_SEPARATOR or " "
  return name .. separator .. second
end

-- Level 0 or an unknown class indicates an unloading/loading world; do not save it.
function readers.summary()
  local _, classToken = try(UnitClass, "player")
  local _, raceToken = try(UnitRace, "player")
  local level = try(UnitLevel, "player")
  if type(classToken) ~= "string" or classToken == "" or type(level) ~= "number" or level < 1 then return nil end
  local money = try(GetMoney)
  local zone = try(GetRealZoneText) or try(GetZoneText)
  return {
    classToken = classToken,
    raceToken = type(raceToken) == "string" and raceToken or "",
    faction = FACTIONS[try(UnitFactionGroup, "player") or ""] or "unknown",
    level = level,
    moneyCopper = type(money) == "number" and money or nil,
    zoneName = type(zone) == "string" and zone or nil,
    fullName = Alts.fullName(),
  }
end

function readers.equipment()
  if not GetInventoryItemID then return nil end
  local items = {}
  for slot = 1, 19 do
    local itemId = try(GetInventoryItemID, "player", slot)
    if type(itemId) == "number" and itemId > 0 then items[#items + 1] = { slot = slot, itemId = itemId } end
  end
  return { items = items }
end

function readers.professions()
  local group = FA.Context.group("professions", true)
  if group.availability ~= "available" or group.coverage ~= "complete" then return nil end
  local list = {}
  for _, p in ipairs(group.value) do
    list[#list + 1] = { skillId = p.skillId, name = p.name, rank = p.rank, maxRank = p.maxRank }
  end
  return { list = list }
end

-- A backpack with no slots indicates an unloaded world, not empty bags.
function readers.bags()
  local items, slots = countItems(bagIds())
  if not items or slots == 0 then return nil end
  return { items = items }
end

function readers.bank()
  if not bankOpen then return nil end
  local items, slots = countItems(bankIds())
  if not items or slots == 0 then return nil end
  return { items = items }
end

-- Non-COD mail attachments only: COD items do not yet belong to the player.
function readers.mail()
  if not mailOpen or not GetInboxNumItems or not GetInboxItem then return nil end
  local counts = {}
  for i = 1, try(GetInboxNumItems) or 0 do
    local cod = select(6, try(GetInboxHeaderInfo, i))
    if not cod or cod == 0 then
      for j = 1, ATTACHMENTS_MAX_RECEIVE or 16 do
        -- GetInboxItem returns name, itemID, texture, count; older clients omit itemID.
        local name, second, third, fourth = try(GetInboxItem, i, j)
        local itemId = type(second) == "number" and second or nil
        if not itemId and GetInboxItemLink then itemId = FA.Context.linkItemId(try(GetInboxItemLink, i, j)) end
        if name and itemId then
          local count = itemId == second and fourth or third
          counts[itemId] = (counts[itemId] or 0) + ((type(count) == "number" and count >= 1) and count or 1)
        end
      end
    end
  end
  local items = {}
  for itemId, count in pairs(counts) do items[#items + 1] = { itemId = itemId, count = count } end
  table.sort(items, function(a, b) return a.itemId < b.itemId end)
  return { items = items }
end

local function skillByName(name)
  return type(name) == "string" and FA.Context.PROFESSION_SKILLS[name] or nil
end

local function isProfession(skillId)
  for _, id in pairs(FA.Context.PROFESSION_SKILLS) do if id == skillId then return true end end
  return false
end

local function spellFromLink(link)
  if type(link) ~= "string" then return nil end
  return tonumber(string.match(link, "enchant:(%d+)") or string.match(link, "spell:(%d+)"))
end

-- New profession window API: recipeID is the spell ID, matching the recipe reference.
-- Do not save another character's window opened through a chat, guild or NPC link.
local function scanModern()
  local T = C_TradeSkillUI
  if try(T.IsTradeSkillLinked) or try(T.IsTradeSkillGuild) or try(T.IsNPCCrafting) then return nil end
  local base = try(T.GetBaseProfessionInfo)
  if type(base) ~= "table" then return nil end
  local skillId = isProfession(base.professionID) and base.professionID or skillByName(base.professionName)
  if not skillId then return nil end
  local all = try(T.GetAllRecipeIDs) or {}
  -- The window may still show a previous profession's recipes; verify its first recipe.
  if all[1] and T.GetProfessionInfoByRecipeID then
    local info = try(T.GetProfessionInfoByRecipeID, all[1])
    if type(info) == "table" then
      local ids = { info.professionID, info.parentProfessionID }
      local names = { info.professionName, info.parentProfessionName }
      local known, match = false, false
      for i = 1, 2 do
        if ids[i] then known = true; if ids[i] == skillId then match = true end end
        if names[i] and skillByName(names[i]) then known = true; if skillByName(names[i]) == skillId then match = true end end
      end
      if known and not match then return nil end
    end
  end
  local spellIds = {}
  for _, id in ipairs(all) do
    local info = try(T.GetRecipeInfo, id)
    if type(id) == "number" and type(info) == "table" and info.learned then spellIds[#spellIds + 1] = id end
  end
  return skillId, spellIds
end

local function scanClassicTrade()
  if try(IsTradeSkillLinked) then return nil end
  local skillId = skillByName((try(GetTradeSkillLine)))
  if not skillId or not GetNumTradeSkills or not GetTradeSkillRecipeLink then return nil end
  local spellIds = {}
  for i = 1, try(GetNumTradeSkills) or 0 do
    local _, kind = try(GetTradeSkillInfo, i)
    if kind ~= "header" and kind ~= "subheader" then
      local spellId = spellFromLink(try(GetTradeSkillRecipeLink, i))
      if spellId then spellIds[#spellIds + 1] = spellId end
    end
  end
  return skillId, spellIds
end

-- Classic Enchanting uses the craft window; GetCraftItemLink supplies the spell link.
local function scanClassicCraft()
  local skillId = skillByName((try(GetCraftDisplaySkillLine)))
  if not skillId or not GetNumCrafts then return nil end
  local spellIds = {}
  for i = 1, try(GetNumCrafts) or 0 do
    local _, _, kind = try(GetCraftInfo, i)
    if kind ~= "header" then
      local spellId = spellFromLink(try(GetCraftRecipeLink, i)) or spellFromLink(try(GetCraftItemLink, i))
      if spellId then spellIds[#spellIds + 1] = spellId end
    end
  end
  return skillId, spellIds
end

-- craft = true means a craft-window event. An empty list never overwrites saved recipes.
function Alts.scanRecipes(craft)
  if not record or leaving then return false end
  local skillId, spellIds
  if craft then
    skillId, spellIds = scanClassicCraft()
  elseif C_TradeSkillUI and C_TradeSkillUI.GetAllRecipeIDs and C_TradeSkillUI.GetRecipeInfo then
    skillId, spellIds = scanModern()
  else
    skillId, spellIds = scanClassicTrade()
  end
  if not skillId or not spellIds or #spellIds == 0 then return false end
  table.sort(spellIds)
  local entry = { skillId = skillId, observedAt = now(), spellIds = spellIds }
  for i, existing in ipairs(record.recipes) do
    if existing.skillId == skillId then record.recipes[i] = entry; return true end
  end
  record.recipes[#record.recipes + 1] = entry
  return true
end

-- Known recipes for the current profession from its most recently viewed window.
function Alts.knownRecipes(skillId)
  for _, entry in ipairs(record and record.recipes or {}) do
    if entry.skillId == skillId then return entry.spellIds, entry.observedAt end
  end
end

-- The recipe appears in one of the current character's observed recipe lists.
function Alts.knowsRecipe(spellId)
  for _, entry in ipairs(record and record.recipes or {}) do
    for _, id in ipairs(entry.spellIds or {}) do
      if id == spellId then return true end
    end
  end
  return false
end

Alts.BASE = { "summary", "equipment", "professions", "bags" }

-- Update a section only after a successful read; otherwise keep its previous data.
function Alts.refresh(names)
  if not record or leaving then return end
  for _, name in ipairs(names or Alts.BASE) do
    local ok, value = pcall(readers[name])
    if ok and value then
      value.observedAt = now()
      record[name] = value
    end
  end
end

-- Character record: use the same identity as messages (Assistant.collectIdentity).
function Alts.attach(identity, characterKey)
  ForeverAssistantDB = ForeverAssistantDB or {}
  local db = ForeverAssistantDB
  db.alts = db.alts or {}
  local r = db.alts[characterKey]
  if type(r) ~= "table" or r.version ~= Alts.VERSION then r = {} end
  r.version = Alts.VERSION
  r.identity = { serverNamespace = identity.serverNamespace, realm = identity.realm, playerGuid = identity.playerGuid, displayName = identity.displayName }
  r.recipes = r.recipes or {}
  db.alts[characterKey] = r
  record = r
  leaving = false
  Alts.record = r
  Alts.refresh()
  return r
end

local function flush()
  scheduled = false
  local names = {}
  for name in pairs(pending) do names[#names + 1] = name end
  pending = {}
  Alts.refresh(names)
end

-- Debounce consecutive events such as BAG_UPDATE into one read.
function Alts.schedule(...)
  for i = 1, select("#", ...) do pending[select(i, ...)] = true end
  if scheduled then return end
  if C_Timer and C_Timer.After then
    scheduled = true
    C_Timer.After(Alts.DELAY, flush)
  else
    flush()
  end
end

local handlers = {
  PLAYER_ENTERING_WORLD = function() leaving = false; Alts.schedule("summary", "equipment", "professions", "bags") end,
  PLAYER_LEAVING_WORLD = function() leaving = true end,
  BAG_UPDATE_DELAYED = function() if bankOpen then Alts.schedule("bags", "bank") else Alts.schedule("bags") end end,
  PLAYER_EQUIPMENT_CHANGED = function() Alts.schedule("equipment") end,
  PLAYER_MONEY = function() Alts.schedule("summary") end,
  PLAYER_LEVEL_UP = function() Alts.schedule("summary") end,
  ZONE_CHANGED_NEW_AREA = function() Alts.schedule("summary") end,
  SKILL_LINES_CHANGED = function() Alts.schedule("professions") end,
  BANKFRAME_OPENED = function() bankOpen = true; Alts.schedule("bank") end,
  BANKFRAME_CLOSED = function() bankOpen = false end,
  PLAYERBANKSLOTS_CHANGED = function() Alts.schedule("bank") end,
  PLAYERBANKBAGSLOTS_CHANGED = function() Alts.schedule("bank") end,
  MAIL_SHOW = function() mailOpen = true; Alts.schedule("mail") end,
  MAIL_INBOX_UPDATE = function() Alts.schedule("mail") end,
  MAIL_CLOSED = function() mailOpen = false end,
  TRADE_SKILL_SHOW = function() Alts.scanRecipes(false); Alts.schedule("professions") end,
  TRADE_SKILL_LIST_UPDATE = function() Alts.scanRecipes(false) end,
  TRADE_SKILL_UPDATE = function() Alts.scanRecipes(false) end,
  CRAFT_SHOW = function() Alts.scanRecipes(true); Alts.schedule("professions") end,
  CRAFT_UPDATE = function() Alts.scanRecipes(true) end,
}

function Alts.onEvent(event)
  local handler = handlers[event]
  if handler then pcall(handler) end
end

-- /fa alts status: saved characters and section observation times.
function Alts.describe()
  local lines = {}
  local db = ForeverAssistantDB and ForeverAssistantDB.alts or {}
  for _, r in pairs(db) do
    if type(r) == "table" and r.identity then
      local parts = {}
      for _, name in ipairs({ "summary", "equipment", "professions", "bags", "bank", "mail" }) do
        if r[name] then parts[#parts + 1] = name end
      end
      parts[#parts + 1] = #(r.recipes or {}) .. " recipe lists"
      local level = r.summary and (" " .. tostring(r.summary.level)) or ""
      lines[#lines + 1] = tostring(r.identity.displayName) .. level .. ": " .. table.concat(parts, ", ")
    end
  end
  table.sort(lines)
  return lines
end

if CreateFrame then
  local events = CreateFrame("Frame")
  for event in pairs(handlers) do
    if events.RegisterEvent then pcall(events.RegisterEvent, events, event) end
  end
  events:SetScript("OnEvent", function(_, event) Alts.onEvent(event) end)
end
