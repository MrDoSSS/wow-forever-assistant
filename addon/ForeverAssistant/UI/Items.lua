-- Game links: Shift+click inserts an item link in the question; question links
-- also populate itemRefs. Verified reply items use links with client tooltips.
-- Build reply links from itemId when the bridge has no itemLink.
local _, FA = ...
local Items = {}
FA.Items = Items

local Json = FA.Json
local Core = FA.Core

local MAX_REFS = 64
local MAP_LINK = "famap:"
local TRACK_LINK = "fatrack:"
local PLAN_LINK = "faplan:"

-- Deduplicated question item links -> ItemInput, up to 64.
function Items.extract(text)
  local refs, seen = Json.array(), {}
  if type(text) ~= "string" then return refs end
  for link in string.gmatch(text, "|c[^|]*|Hitem:%d+[^|]*|h%[[^|]*%]|h|r") do
    local id = FA.Context.itemLinkId(link)
    if id and not seen[link] and #refs < MAX_REFS then
      seen[link] = true
      refs[#refs + 1] = { itemId = id, itemLink = link }
    end
  end
  return refs
end

-- Display link: supplied client link, cached client link or minimal link by ID.
function Items.linkFor(ref)
  if type(ref) ~= "table" or type(ref.itemId) ~= "number" then return nil end
  if type(ref.itemLink) == "string" and ref.itemLink ~= "" then return ref.itemLink end
  local _, link = Core.try(GetItemInfo, ref.itemId)
  if type(link) == "string" then return link end
  return "|cffffffff|Hitem:" .. ref.itemId .. "|h[item " .. ref.itemId .. "]|h|r"
end

-- Map link: green if verified, orange if unverified;
-- adjacent [Track] activates the client's waypoint. The link names the NPC or place
-- (the zone without a title); zone and coordinates are in its tooltip. A point outside
-- the player's map is plain text with coordinates, the only way to find it.
function Items.mapLink(entryId, point, pointIndex)
  if not point.mapId then return FA.Map.label(point) .. " (zone not found on your map)" end
  local label = point.title or point.zoneName
  local target = entryId .. (pointIndex and (":" .. pointIndex) or "")
  local track = " |cff40c0ff|H" .. TRACK_LINK .. target .. "|h[Track]|h|r"
  if point.verified then return "|cff66ff66|H" .. MAP_LINK .. target .. "|h[" .. label .. "]|h|r" .. track end
  return "|cffff9933|H" .. MAP_LINK .. target .. "|h[" .. label .. "]|h|r" .. track
end

-- Replace [[item:<refId>]] and [[map:<index>]] markers with inline links.
-- Support legacy [[map]]; list unmarked points below the answer.
function Items.renderEntry(entry)
  local refs, used = {}, {}
  for _, ref in ipairs(entry.itemRefs or {}) do
    if type(ref) == "table" and type(ref.refId) == "string" then refs[ref.refId] = ref end
  end
  local multiple = type(entry.locations) == "table" and #entry.locations > 0
  local pointCount = multiple and #entry.locations or (FA.Map.pointOf(entry) and 1 or 0)
  local mapUsed = {}
  local text = string.gsub(entry.text or "", "%[%[([^%]]*)%]%]", function(body)
    local refId = string.match(body, "^item:(%x+)$")
    if refId then
      local ref = refs[refId]
      if not ref then return "[item]" end
      used[ref] = true
      return Items.linkFor(ref)
    end
    local pointIndex = body == "map" and 1 or tonumber(string.match(body, "^map:(%d+)$"))
    if pointIndex then
      local point = FA.Map.pointOf(entry, pointIndex)
      if not point then return "[map]" end
      mapUsed[pointIndex] = true
      return Items.mapLink(entry.entryId, point, multiple and pointIndex or nil)
    end
    return nil
  end)
  local lines, links = {}, {}
  for _, ref in ipairs(entry.itemRefs or {}) do
    if not used[ref] then links[#links + 1] = Items.linkFor(ref) end
  end
  if #links > 0 then lines[#lines + 1] = "|cffaaaaaaItems:|r " .. table.concat(links, " ") end
  for i = 1, pointCount do
    local point = FA.Map.pointOf(entry, i)
    if point and not mapUsed[i] then
      lines[#lines + 1] = "|cffaaaaaaMap:|r " .. Items.mapLink(entry.entryId, point, multiple and i or nil)
    end
  end
  if type(entry.plan) == "table" and type(entry.plan.steps) == "table" then
    local action = FA.Plan.isActiveEntry(entry) and ("|cff66ff66|H" .. PLAN_LINK .. "open|h[Active plan: open]|h|r")
      or ("|cff40c0ff|H" .. PLAN_LINK .. "activate:" .. tostring(entry.entryId) .. "|h[Make active plan]|h|r")
    lines[#lines + 1] = string.format("|cffaaaaaaPlan:|r %s (%d steps) %s", tostring(entry.plan.title), #entry.plan.steps, action)
  end
  for _, limitation in ipairs(entry.limitations or {}) do
    lines[#lines + 1] = "|cff888888- " .. tostring(limitation) .. "|r"
  end
  return text, lines
end

local function linkTarget(link, prefix)
  if type(link) ~= "string" or string.sub(link, 1, #prefix) ~= prefix then return nil end
  local target = string.sub(link, #prefix + 1)
  local entryId, index = string.match(target, "^([^:]+):(%d+)$")
  if entryId then
    index = tonumber(index)
    if not index or index < 1 or index > 20 then return nil end
    return entryId, index
  end
  if target == "" or string.find(target, ":", 1, true) then return nil end
  return target
end

function Items.mapEntryId(link)
  return linkTarget(link, MAP_LINK)
end

function Items.trackEntryId(link)
  return linkTarget(link, TRACK_LINK)
end

-- Plan actions: activate:<entryId>, open, toggle:<step>, mail:<recipientIndex>, clear.
function Items.planAction(link)
  if type(link) ~= "string" or string.sub(link, 1, #PLAN_LINK) ~= PLAN_LINK then return nil end
  local action, argument = string.match(string.sub(link, #PLAN_LINK + 1), "^(%a+):?(.*)$")
  return action, argument
end

-- Support ChatFrameUtil and legacy ChatEdit_InsertLink. An open assistant chat accepts
-- items after bag clicks, while an active game chat input retains priority.
function Items.hookInsert(input)
  if Items.hooked or type(hooksecurefunc) ~= "function" then return false end
  local api = ChatFrameUtil or {}
  local function insert(link)
    if not FA.Context.itemLinkId(link) or not input:IsVisible() then return end
    local active = Core.try(api.GetActiveWindow or ChatEdit_GetActiveWindow)
    if active and active ~= input and Core.try(active.HasFocus, active) then return end
    input:Insert(link)
    input:SetFocus()
  end
  -- In newer clients the global function may wrap InsertLink;
  -- one handler prevents double insertion through the wrapper.
  if type(api.InsertLink) == "function" then
    hooksecurefunc(api, "InsertLink", insert)
  elseif type(ChatEdit_InsertLink) == "function" then
    hooksecurefunc("ChatEdit_InsertLink", insert)
  else
    return false
  end
  Items.hooked = true
  return true
end

-- Chat link hover: item tooltip or map point hint.
function Items.onEnter(owner, link)
  if not GameTooltip then return end
  local entryId, pointIndex = Items.mapEntryId(link)
  local trackId, trackIndex = Items.trackEntryId(link)
  local planAction = Items.planAction(link)
  GameTooltip:SetOwner(owner, "ANCHOR_CURSOR")
  if planAction then
    GameTooltip:AddLine(Items.PLAN_TIPS[planAction] or "Plan")
    GameTooltip:Show()
  elseif trackId then
    local point = FA.Map.pointForEntry(trackId, trackIndex)
    GameTooltip:AddLine("Track with the built-in waypoint")
    if point then GameTooltip:AddLine(FA.Map.label(point), 1, 1, 1) end
    GameTooltip:AddLine("/fa map clear stops tracking", 0.6, 0.6, 0.6)
    GameTooltip:Show()
  elseif entryId then
    local point = FA.Map.pointForEntry(entryId, pointIndex)
    GameTooltip:AddLine("Show on the world map")
    if point then
      GameTooltip:AddLine(FA.Map.label(point), 1, 1, 1)
      if point.verified then
        GameTooltip:AddLine("Verified: map confirmed by your client", 0.4, 1, 0.4)
      else
        GameTooltip:AddLine("Not verified", 1, 0.5, 0.25)
        if point.source then GameTooltip:AddLine("Source: " .. point.source, 0.8, 0.8, 0.8, true) end
      end
    end
    GameTooltip:Show()
  elseif string.sub(link, 1, 5) == "item:" then
    Core.try(GameTooltip.SetHyperlink, GameTooltip, link)
    GameTooltip:Show()
  end
end

Items.PLAN_TIPS = {
  activate = "Show this plan in the plan window and tick its steps as you go",
  open = "Open the plan window",
  toggle = "Mark this step done or not done",
  mail = "Fill a letter with this character's items and gold for the plan. You press Send.",
  clear = "Close the plan",
}

function Items.onLeave()
  if GameTooltip then GameTooltip:Hide() end
end

-- Click: show a map point; Shift+click an item into the question; otherwise use the standard link action.
function Items.onClick(link, text, button, input)
  if Items.planAction(link) then
    Core.ui("planLink", link)
    return
  end
  local entryId, pointIndex = Items.mapEntryId(link)
  local trackId, trackIndex = Items.trackEntryId(link)
  if entryId or trackId then
    local ok, reason
    if trackId then ok, reason = FA.Map.trackEntry(trackId, trackIndex) else ok, reason = FA.Map.showEntry(entryId, pointIndex) end
    if not ok then Core.ui("setStatus", FA.Map.REASONS[reason] or tostring(reason)) end
    return
  end
  if string.sub(link, 1, 5) ~= "item:" then return end
  if IsModifiedClick and IsModifiedClick("CHATLINK") and input then
    input:Insert(text)
    input:SetFocus()
    return
  end
  if SetItemRef then Core.try(SetItemRef, link, text, button) end
end
