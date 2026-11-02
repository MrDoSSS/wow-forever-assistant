-- Active plan: per-character steps from assistant replies, player marks,
-- auto-completion and mail preparation. One plan per account (ForeverAssistantDB.plan),
-- visible on every character. The bridge stores the plan in its reply, so questions
-- send only that reply's key and step marks (activePlan).
local _, FA = ...
local Plan = {}
FA.Plan = Plan

local Json = FA.Json
local Core = FA.Core

Plan.MAX_ATTACHMENTS = 12
Plan.REASONS = {
  no_plan = "No active plan.",
  mailbox_closed = "Open a mailbox first.",
  combat = "Not available in combat.",
  nothing = "Nothing to mail from this character.",
  no_items = "The items for this letter are not in your bags.",
}
Plan.NO_SURNAME = "%s has no saved surname: log in on %s once so the mail reaches the right character."


local mailOpen = false
local keepTicks = false -- Plan.revise: activate transfers the previous plan's marks.
local pendingMail -- mail prepared from the plan: { recipient, sent = { [step] = count } }

local function copy(value)
  if type(value) ~= "table" then return value end
  local result = {}
  for k, v in pairs(value) do result[k] = copy(v) end
  return result
end

local function db()
  ForeverAssistantDB = ForeverAssistantDB or {}
  return ForeverAssistantDB
end

local function str(value)
  if type(value) == "string" and value ~= "" then return value end
end

local function squash(s)
  return string.lower((string.gsub(s, "%s+", "")))
end

-- Character names may be full "Name Surname" or just first names; the model uses both.
-- Compare first names when either side lacks a surname.
local function sameName(a, b)
  if not str(a) or not str(b) then return false end
  if squash(a) == squash(b) then return true end
  if string.find(a, "%s") and string.find(b, "%s") then return false end
  return string.lower(string.match(a, "^(%S+)")) == string.lower(string.match(b, "^(%S+)"))
end
Plan.sameName = sameName

function Plan.active()
  local plan = db().plan
  if type(plan) == "table" and type(plan.steps) == "table" and #plan.steps > 0 then return plan end
end

function Plan.me()
  local identity = FA.Assistant.session.identity
  return identity and identity.displayName
end

-- A step for the current character; an unnamed step can be done by any character.
function Plan.isMine(step)
  return not str(step.character) or sameName(step.character, FA.Alts.fullName() or Plan.me())
end

-- Mail recipient: saved character's full name. The second return value indicates
-- a missing saved surname for a character expected to have one.
function Plan.mailName(name)
  local best, exact
  for _, r in pairs(db().alts or {}) do
    local identity, summary = type(r) == "table" and r.identity, type(r) == "table" and r.summary
    local display, full = identity and identity.displayName, summary and str(summary.fullName)
    if sameName(name, display) or (full and sameName(name, full)) then
      local candidate = full or display
      if squash(candidate) == squash(name) or (display and squash(display) == squash(name)) then exact = candidate end
      best = best or candidate
    end
  end
  local found = exact or best or name
  local mine = FA.Alts.fullName()
  local needsSurname = mine ~= nil and string.find(mine, "%s") ~= nil and not string.find(found, "%s")
  return found, needsSurname
end

function Plan.itemId(step)
  return type(step.item) == "table" and type(step.item.itemId) == "number" and step.item.itemId or nil
end

-- History entries with or without plans; true means this entry's plan is active.
function Plan.isActiveEntry(entry)
  local plan = Plan.active()
  return plan ~= nil and type(entry) == "table" and plan.entryId == entry.entryId
end

-- Activate the reply's plan and reset previous step marks.
function Plan.activate(entry)
  if type(entry) ~= "table" or type(entry.plan) ~= "table" or type(entry.plan.steps) ~= "table" then return false end
  local previous = db().plan
  db().plan = {
    title = str(entry.plan.title) or "Plan",
    steps = copy(entry.plan.steps),
    locations = copy(entry.locations),
    request = copy(entry.request),
    entryId = entry.entryId,
    done = {},
    overridden = {},
    sent = {},
    createdAt = time and time() or 0,
  }
  pendingMail = nil
  local kept = 0
  if keepTicks then kept = Plan.carryTicks(previous, db().plan) end
  Plan.refresh()
  Core.ui("renderPlan")
  return true, kept
end

-- A step is unchanged when kind, character, item, quantity, recipient and text match.
local function stepKey(step)
  return table.concat({ tostring(step.kind), squash(str(step.character) or ""), tostring(Plan.itemId(step)),
    tostring(step.quantity), squash(str(step.mailTo) or ""), squash(str(step.mailFrom) or ""), tostring(step.text) }, "|")
end

-- Transfer old completion marks to unchanged steps; return the number transferred.
function Plan.carryTicks(old, new)
  if type(old) ~= "table" or type(old.steps) ~= "table" then return 0 end
  local byKey = {}
  for i, step in ipairs(old.steps) do
    local key = stepKey(step)
    byKey[key] = byKey[key] or {}
    table.insert(byKey[key], i)
  end
  local kept = 0
  for i, step in ipairs(new.steps) do
    local same = byKey[stepKey(step)]
    local from = same and table.remove(same, 1)
    if from then
      new.done[i], new.overridden[i] = old.done and old.done[from] or nil, old.overridden and old.overridden[from] or nil
      new.sent[i] = old.sent and old.sent[from] or nil
      if new.done[i] then kept = kept + 1 end
    end
  end
  return kept
end

-- Correction from chat: a reply to a question asked under the active plan replaces
-- it automatically while preserving unchanged step marks.
function Plan.revise(entry, askedWithEntryId)
  local plan = Plan.active()
  if not plan or plan.entryId ~= askedWithEntryId or type(entry) ~= "table" or type(entry.plan) ~= "table" then return false end
  keepTicks = true
  local ok, kept = Plan.activate(entry)
  keepTicks = false
  if ok then Core.ui("setStatus", string.format("The active plan was updated: %d ticks kept.", kept or 0)) end
  return ok, kept
end

function Plan.clear()
  db().plan = nil
  pendingMail = nil
  Core.ui("renderPlan")
  Core.ui("render")
end

function Plan.progress()
  local plan = Plan.active()
  if not plan then return 0, 0 end
  local done = 0
  for i = 1, #plan.steps do if plan.done[i] then done = done + 1 end end
  return done, #plan.steps
end

-- Never automatically recheck a step the player unchecked.
function Plan.toggle(index)
  local plan = Plan.active()
  if not plan or not plan.steps[index] then return false end
  plan.done[index] = not plan.done[index] or nil
  plan.overridden[index] = not plan.done[index] or nil
  Core.ui("renderPlan")
  return true
end

local function itemCount(itemId)
  local count = Core.try(GetItemCount, itemId, true)
  if count == nil and C_Item then count = Core.try(C_Item.GetItemCount, itemId, true) end
  return tonumber(count) or 0
end

-- Current character's profession skill; nil if absent or not read.
function Plan.skillRank(skillId)
  local group = FA.Context.group("professions", true)
  if group.availability ~= "available" then return nil end
  for _, p in ipairs(group.value or {}) do
    if p.skillId == skillId then return p.rank end
  end
end

-- Distance to a step point on the character's map, as a fraction of the zone map width.
Plan.NEAR = 0.02
function Plan.nearPoint(plan, step)
  local point = tonumber(step.location) and FA.Map.pointOf(plan, step.location)
  if not point or not point.mapId or not C_Map then return false end
  local mapId = Core.try(C_Map.GetBestMapForUnit, "player")
  local position = mapId and Core.try(C_Map.GetPlayerMapPosition, mapId, "player")
  if type(position) ~= "table" then return false end
  local px, py = position.x, position.y
  if position.GetXY then px, py = position:GetXY() end
  local x, y = FA.Map.project(point, mapId)
  if type(px) ~= "number" or type(x) ~= "number" then return false end
  return math.sqrt((px - x) ^ 2 + (py - y) ^ 2) <= Plan.NEAR
end

-- Mail from the collect step's sender in the open mailbox, with money or attachments.
local function lettersFrom(sender)
  local count = 0
  for i = 1, tonumber((Core.try(GetInboxNumItems))) or 0 do
    local _, _, from, _, money, _, _, items = Core.try(GetInboxHeader, i)
    if sameName(from, sender) and ((tonumber(money) or 0) > 0 or (tonumber(items) or 0) > 0) then count = count + 1 end
  end
  return count
end

-- Complete collect when mail from that sender was present and has been emptied.
local function checkInbox(plan)
  if not mailOpen then return false end
  local changed = false
  plan.seen = plan.seen or {}
  for i, step in ipairs(plan.steps) do
    if step.kind == "collect" and not plan.done[i] and not plan.overridden[i] and str(step.mailFrom) and Plan.isMine(step) then
      if lettersFrom(step.mailFrom) > 0 then
        plan.seen[i] = true
      elseif plan.seen[i] then
        plan.done[i], changed = true, true
      end
    end
  end
  return changed
end

-- Auto-complete steps for the current character: login, items in bags or bank, profession
-- skill, learned recipe, map point and collected mail. Redraw even without new marks
-- because the window also displays current item counts and skill progress.
function Plan.refresh()
  local plan = Plan.active()
  if not plan then return false end
  local changed = checkInbox(plan)
  for i, step in ipairs(plan.steps) do
    if not plan.done[i] and not plan.overridden[i] and Plan.isMine(step) then
      local itemId, quantity = Plan.itemId(step), tonumber(step.quantity)
      local done = false
      if step.kind == "login" then
        done = str(step.character) ~= nil
      elseif type(step.skillId) == "number" and type(step.skillRank) == "number" then
        done = (Plan.skillRank(step.skillId) or 0) >= step.skillRank
      elseif (step.kind == "get" or step.kind == "craft") and itemId and quantity then
        done = itemCount(itemId) >= quantity
      elseif step.kind == "learn" and type(step.recipeSpellId) == "number" then
        done = Core.try(IsPlayerSpell, step.recipeSpellId) == true or FA.Alts.knowsRecipe(step.recipeSpellId)
      elseif step.kind == "goto" then
        done = Plan.nearPoint(plan, step)
      end
      if done then plan.done[i] = true; changed = true end
    end
  end
  Core.ui("renderPlan")
  return changed
end

-- Check current-character goto steps every 2 seconds while any remain.
local function needsPosition()
  local plan = Plan.active()
  for i, step in ipairs(plan and plan.steps or {}) do
    if step.kind == "goto" and tonumber(step.location) and not plan.done[i] and not plan.overridden[i] and Plan.isMine(step) then return true end
  end
  return false
end

function Plan.checkPosition()
  if needsPosition() then
    local plan = Plan.active()
    for i, step in ipairs(plan.steps) do
      if step.kind == "goto" and not plan.done[i] and not plan.overridden[i] and Plan.isMine(step) and Plan.nearPoint(plan, step) then
        plan.done[i] = true
        Core.ui("renderPlan")
      end
    end
  end
end

-- Marks for the question: the bridge loads the plan by reply key and applies the marks.
function Plan.queryRef()
  local plan = Plan.active()
  local key = plan and plan.request
  if type(key) ~= "table" or not str(key.characterKey) or not str(key.originSessionId) or type(key.requestId) ~= "number" then
    return nil
  end
  local done = Json.array()
  for i = 1, math.min(#plan.steps, 30) do done[i] = plan.done[i] == true end
  return {
    request = { characterKey = key.characterKey, originSessionId = key.originSessionId, requestId = key.requestId },
    done = done,
  }
end

-- Mail ------------------------------------------------------------------

-- Current character's unsent mail recipients, in step order.
function Plan.recipients()
  local plan = Plan.active()
  local list, seen = {}, {}
  for i, step in ipairs(plan and plan.steps or {}) do
    local to = str(step.mailTo)
    if step.kind == "mail" and not plan.done[i] and to and str(step.character) and Plan.isMine(step) and not seen[squash(to)] then
      seen[squash(to)] = true
      list[#list + 1] = to
    end
  end
  return list
end

function Plan.mailOpen()
  return mailOpen
end

local function containerInfo(bag, slot)
  local container = C_Container or {}
  if container.GetContainerItemInfo then
    local info = Core.try(container.GetContainerItemInfo, bag, slot)
    if type(info) == "table" then return info.itemID, info.stackCount or 1, info.isLocked end
    return nil
  end
  if GetContainerItemInfo then
    local _, count, locked, _, _, _, _, _, _, itemId = Core.try(GetContainerItemInfo, bag, slot)
    return itemId, count or 1, locked
  end
end

-- Free item stacks in bags, excluding stacks already attached to mail.
local function stacksOf(itemId)
  local numSlots = (C_Container and C_Container.GetContainerNumSlots) or GetContainerNumSlots
  local stacks = {}
  if not numSlots then return stacks end
  for bag = 0, NUM_BAG_SLOTS or 4 do
    for slot = 1, Core.try(numSlots, bag) or 0 do
      local id, count, locked = containerInfo(bag, slot)
      if id == itemId and not locked then stacks[#stacks + 1] = { bag = bag, slot = slot, count = count } end
    end
  end
  return stacks
end

local function attach(stack, count, used)
  if used >= Plan.MAX_ATTACHMENTS then return false end
  local container = C_Container or {}
  if count < stack.count then
    Core.try(container.SplitContainerItem or SplitContainerItem, stack.bag, stack.slot, count)
  else
    Core.try(container.PickupContainerItem or PickupContainerItem, stack.bag, stack.slot)
  end
  Core.try(ClickSendMailItemButton)
  return true
end

-- Mail for a recipient combines all this character's unsent steps, up to 12 attachments.
-- The player sends it; mark steps after MAIL_SEND_SUCCESS.
function Plan.fillMail(recipient)
  local plan = Plan.active()
  if not plan then return nil, "no_plan" end
  if not mailOpen then return nil, "mailbox_closed" end
  if InCombatLockdown and InCombatLockdown() then return nil, "combat" end
  local steps = {}
  for i, step in ipairs(plan.steps) do
    if step.kind == "mail" and not plan.done[i] and sameName(step.mailTo, recipient) and Plan.isMine(step) then
      steps[#steps + 1] = i
    end
  end
  if #steps == 0 then return nil, "nothing" end
  local address, noSurname = Plan.mailName(recipient)
  if MailFrameTab_OnClick then Core.try(MailFrameTab_OnClick, nil, 2) end
  Core.try(ClearSendMail)
  if SendMailNameEditBox then SendMailNameEditBox:SetText(address) end
  if SendMailSubjectEditBox then SendMailSubjectEditBox:SetText(Core.utf8Truncate(plan.title, 64)) end
  local used, money, sent, short = 0, 0, {}, false
  for _, i in ipairs(steps) do
    local step = plan.steps[i]
    local itemId = Plan.itemId(step)
    local wanted = itemId and math.max(0, (tonumber(step.quantity) or 0) - (plan.sent[i] or 0)) or 0
    local attached = 0
    if wanted > 0 then
      for _, stack in ipairs(stacksOf(itemId)) do
        if attached >= wanted then break end
        local count = math.min(stack.count, wanted - attached)
        if not attach(stack, count, used) then break end
        used, attached = used + 1, attached + count
      end
      if attached < wanted then short = true end
    end
    local copper = tonumber(step.moneyCopper) or 0
    money = money + copper
    if attached > 0 or copper > 0 then sent[i] = attached end
  end
  if money > 0 then
    if MoneyInputFrame_SetCopper and SendMailMoney then Core.try(MoneyInputFrame_SetCopper, SendMailMoney, money)
    else Core.try(SetSendMailMoney, money) end
  end
  if next(sent) == nil then return nil, "no_items" end
  pendingMail = { recipient = recipient, sent = sent }
  return { attachments = used, money = money, short = short, address = address, noSurname = noSurname }
end

-- Credit sent attachments to steps; mark each step once its full quantity is sent.
function Plan.onMailSent()
  local plan, mail = Plan.active(), pendingMail
  pendingMail = nil
  if not plan or not mail then return false end
  for i, count in pairs(mail.sent) do
    local step = plan.steps[i]
    if step then
      plan.sent[i] = (plan.sent[i] or 0) + count
      if not Plan.itemId(step) or plan.sent[i] >= (tonumber(step.quantity) or 0) then plan.done[i] = true end
    end
  end
  Core.ui("renderPlan")
  return true
end

local refreshScheduled = false
local function scheduleRefresh()
  if refreshScheduled then return end
  if C_Timer and C_Timer.After then
    refreshScheduled = true
    C_Timer.After(0.5, function() refreshScheduled = false; Plan.refresh() end)
  else
    Plan.refresh()
  end
end

local handlers = {
  PLAYER_ENTERING_WORLD = scheduleRefresh,
  BAG_UPDATE_DELAYED = scheduleRefresh,
  TRADE_SKILL_SHOW = scheduleRefresh,
  CRAFT_SHOW = scheduleRefresh,
  NEW_RECIPE_LEARNED = scheduleRefresh,
  LEARNED_SPELL_IN_TAB = scheduleRefresh,
  SKILL_LINES_CHANGED = scheduleRefresh,
  ZONE_CHANGED_NEW_AREA = scheduleRefresh,
  MAIL_SHOW = function()
    mailOpen = true
    Plan.refresh()
    if #Plan.recipients() > 0 then Core.ui("showPlan") end
  end,
  MAIL_INBOX_UPDATE = function() Plan.refresh() end,
  MAIL_CLOSED = function() mailOpen = false; pendingMail = nil; Core.ui("renderPlan") end,
  MAIL_SEND_SUCCESS = function() Plan.onMailSent() end,
  MAIL_FAILED = function() pendingMail = nil end,
}

function Plan.onEvent(event)
  local handler = handlers[event]
  if handler then pcall(handler) end
end

if CreateFrame then
  local events = CreateFrame("Frame")
  for event in pairs(handlers) do
    if events.RegisterEvent then pcall(events.RegisterEvent, events, event) end
  end
  events:SetScript("OnEvent", function(_, event) Plan.onEvent(event) end)
  if C_Timer and C_Timer.NewTicker then C_Timer.NewTicker(2, function() pcall(Plan.checkPosition) end) end
end
