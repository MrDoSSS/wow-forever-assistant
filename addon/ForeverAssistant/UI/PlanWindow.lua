-- Active plan window: checkable steps, item and map links, and mail preparation
-- at the mailbox. Labels use Latin letters for enUS fonts; step text comes from the model.
local _, FA = ...
local UI, Core = FA.UI, FA.Core
local T = UI.Theme
local Plan = FA.Plan
local frame, header, title, progress, log, measurer, status, resize, fitIcon, lockIcon
local renderedLines, pending = 0, {}
local sizing, sizeRenderPending = false, false

local LINE_SPACING = 4
local WHEEL_LINES = 2
local HEADER, FOOTER = 66, 30
local MIN_WIDTH, MAX_WIDTH, MIN_HEIGHT, MAX_HEIGHT = 300, 900, 120, 1200
local SCREEN_MARGIN = 8

-- Plan window appearance, configured in UI/Settings.lua: background opacity
-- (0 leaves only text, like a quest tracker), text size and position locking.
-- Height: autoHeight fits the line count; resizing manually uses the player's
-- width/height until auto-height is enabled again. Keep the top edge fixed and
-- never extend below the screen; scroll overflowing content instead.
UI.PLAN_DEFAULTS = { opacity = 0.96, fontSize = 14, locked = false, autoHeight = true, width = 440, height = 480 }

function UI.planPreferences()
  local ui = UI.preferences()
  ui.plan = type(ui.plan) == "table" and ui.plan or {}
  local p = ui.plan
  for key, value in pairs(UI.PLAN_DEFAULTS) do
    if type(p[key]) ~= type(value) then p[key] = value end
  end
  p.opacity = math.max(0, math.min(1, p.opacity))
  p.fontSize = math.max(10, math.min(20, p.fontSize))
  p.width = math.max(MIN_WIDTH, math.min(MAX_WIDTH, p.width))
  p.height = math.max(MIN_HEIGHT, math.min(MAX_HEIGHT, p.height))
  return p
end
local prefs = UI.planPreferences

-- Anchor at the top left: height changes downward without moving the title.
local function saveLayout()
  local left, top = tonumber((frame:GetLeft())), tonumber((frame:GetTop()))
  if not left or not top then return end
  frame:ClearAllPoints()
  frame:SetPoint("TOPLEFT", UIParent, "BOTTOMLEFT", left, top)
  local p = prefs()
  p.point, p.relativePoint, p.x, p.y = "TOPLEFT", "BOTTOMLEFT", left, top
end

-- Space between the window's top edge and the bottom of the screen.
local function roomBelowTop()
  local top = tonumber((frame:GetTop())) or tonumber((UIParent:GetHeight())) or MAX_HEIGHT
  return math.max(MIN_HEIGHT, top - SCREEN_MARGIN)
end

local function setStatus(text)
  if status then status:SetText(text or "") end
end

local function lineHeight()
  measurer:SetText("Ag")
  local height = tonumber((measurer:GetStringHeight())) or 0
  measurer:SetText("")
  if height <= 0 then height = prefs().fontSize end
  return height + LINE_SPACING
end

-- Visible list lines based on window height; the client updates the list's size later.
local function visibleLines()
  local height = (tonumber((frame:GetHeight())) or 0) - HEADER - FOOTER
  return math.max(1, math.floor(height / lineHeight()))
end

local function maxScroll()
  return math.max(0, renderedLines - visibleLines())
end

local function scroll(delta)
  local offset = tonumber((log.GetScrollOffset and log:GetScrollOffset())) or 0
  offset = math.max(0, math.min(maxScroll(), offset + delta * WHEEL_LINES))
  if log.SetScrollOffset then log:SetScrollOffset(offset) end
end

-- Collect lines first; render in finish after choosing the window height.
local function addLines(text, r, g, b)
  local width = (tonumber((frame:GetWidth())) or 0) - 38
  local lines = FA.Wrap.lines(text, width, function(s) measurer:SetText(s); return measurer:GetStringWidth() end)
  measurer:SetText("")
  for _, line in ipairs(lines) do pending[#pending + 1] = { line ~= "" and line or " ", r, g, b } end
end

-- Height fits content or the player's setting, bounded by the screen. The
-- ScrollingMessageFrame grows upward, so pad short plans with empty lines
-- below them to keep text at the top regardless of window height.
local function finish()
  local p, lh = prefs(), lineHeight()
  if not sizing then
    local wanted = p.autoHeight and (HEADER + FOOTER + #pending * lh + 6) or p.height
    frame:SetHeight(math.max(MIN_HEIGHT, math.min(wanted, roomBelowTop())))
  end
  log:Clear()
  for _, line in ipairs(pending) do log:AddMessage(line[1], line[2], line[3], line[4]) end
  local padding = math.max(0, visibleLines() - 1 - #pending)
  for _ = 1, padding do log:AddMessage(" ") end
  renderedLines = #pending + padding
  pending = {}
  if log.SetScrollOffset then log:SetScrollOffset(maxScroll()) end
end
UI.planRenderedLines = function() return renderedLines end

-- Background and border fade together; at opacity 0, only text and the title divider remain.
function UI.applyPlanAppearance()
  if not frame then return end
  local p = prefs()
  if frame.SetBackdropColor then
    frame:SetBackdropColor(0.045, 0.042, 0.038, p.opacity)
    frame:SetBackdropBorderColor(0.35, 0.29, 0.19, math.min(1, p.opacity * 1.2))
  end
  T.setContentFont(log, p.fontSize)
  T.setContentFont(measurer, p.fontSize)
  frame:SetWidth(p.width)
  if p.locked then resize:Hide() else resize:Show() end
  UI.refreshPlanIcons()
  UI.renderPlan()
end

-- Header icons use client textures also used by Forever addons: the lock from
-- EllesmereUI Forever Essentials and sorting arrows. Disabled icons are gray.
local LOCKED = "Interface\\Buttons\\LockButton-Locked-Up"
local UNLOCKED = "Interface\\Buttons\\LockButton-Unlocked-Up"
local LOCK_COORDS = { 0.1875, 0.78125, 0.21875, 0.78125 }

local function iconButton(tip, onClick)
  local b = CreateFrame("Button", nil, header)
  b:SetSize(18, 18); b.textures = {}
  b:SetHighlightTexture("Interface\\Buttons\\UI-Common-MouseHilight", "ADD")
  b:SetScript("OnClick", onClick)
  b:SetScript("OnEnter", function(self)
    if not GameTooltip then return end
    GameTooltip:SetOwner(self, "ANCHOR_TOP"); GameTooltip:AddLine(tip()); GameTooltip:Show()
  end)
  b:SetScript("OnLeave", function() if GameTooltip then GameTooltip:Hide() end end)
  return b
end

local function texture(button, file, width, height, point, y)
  local t = button:CreateTexture(nil, "ARTWORK")
  t:SetTexture(file); t:SetSize(width, height); t:SetPoint(point, 0, y)
  button.textures[#button.textures + 1] = t
  return t
end

local function paint(button, on)
  for _, t in ipairs(button.textures) do
    if t.SetDesaturated then t:SetDesaturated(not on) end
    t:SetAlpha(on and 1 or 0.55)
  end
  button.on = on
end

function UI.refreshPlanIcons()
  if not fitIcon then return end
  local p = prefs()
  paint(fitIcon, p.autoHeight)
  lockIcon.image:SetTexture(p.locked and LOCKED or UNLOCKED)
  lockIcon.image:SetTexCoord(LOCK_COORDS[1], LOCK_COORDS[2], LOCK_COORDS[3], LOCK_COORDS[4])
  paint(lockIcon, p.locked)
end

local function buildIcons()
  -- Fit-to-content icon: up and down arrows.
  fitIcon = iconButton(function()
    return prefs().autoHeight and "Height follows the steps (click to keep the current height)" or "Fit the height to the steps"
  end, function()
    local p = prefs(); p.autoHeight = not p.autoHeight
    if not p.autoHeight then p.height = math.floor((tonumber((frame:GetHeight())) or p.height) + 0.5) end
    UI.applyPlanAppearance(); Core.ui("refreshSettings")
  end)
  fitIcon:SetPoint("TOPRIGHT", -24, 0)
  texture(fitIcon, "Interface\\Buttons\\Arrow-Up-Up", 14, 11, "TOP", 0)
  texture(fitIcon, "Interface\\Buttons\\Arrow-Down-Up", 14, 11, "BOTTOM", 0)
  UI.planFitIcon = fitIcon
  lockIcon = iconButton(function()
    return prefs().locked and "Position and size are locked (click to unlock)" or "Lock position and size"
  end, function()
    local p = prefs(); p.locked = not p.locked
    UI.applyPlanAppearance(); Core.ui("refreshSettings")
  end)
  lockIcon:SetPoint("TOPRIGHT", -2, 0)
  lockIcon.image = texture(lockIcon, UNLOCKED, 16, 16, "CENTER", 0)
  UI.planLockIcon = lockIcon
  -- Settings gear, as used by Details: open the assistant's plan-window settings.
  local options = iconButton(function() return "Plan window settings" end, function() UI.openPlanSettings() end)
  options:SetPoint("TOPRIGHT", -46, 0)
  -- The client gear is yellow; gray matches disabled icons without a glowing appearance.
  local gear = texture(options, "Interface\\Buttons\\UI-OptionsButton", 14, 14, "CENTER", 0)
  if gear.SetDesaturated then gear:SetDesaturated(true) end
  gear:SetVertexColor(0.85, 0.85, 0.85)
  UI.planSettingsIcon = options
end

function UI.openPlanSettings()
  UI.ensure()
  UI.frame:Show()
  UI.showSettings(true)
  if UI.settings and UI.settings.scrollTo then UI.settings.scrollTo(math.huge) end
end

local function money(copper)
  if GetCoinTextureString then
    local text = Core.try(GetCoinTextureString, copper)
    if type(text) == "string" then return text end
  end
  local gold, silver = math.floor(copper / 10000), math.floor(copper / 100) % 100
  return string.format("%dg %ds %dc", gold, silver, copper % 100)
end

local KIND = { get = "Get", craft = "Craft", learn = "Learn", mail = "Mail", collect = "Collect", login = "Log in", ["goto"] = "Go", ["do"] = "Do" }

-- Step row: checkbox, character, action, item quantity, point and recipient.
function UI.planStepText(plan, index)
  local step = plan.steps[index]
  local done = plan.done[index]
  local box = done and "|cff66ff66[x]|r" or "|cffbbbbbb[  ]|r"
  local parts = { "|Hfaplan:toggle:" .. index .. "|h" .. box .. "|h", index .. "." }
  if type(step.character) == "string" and step.character ~= "" then
    parts[#parts + 1] = (Plan.isMine(step) and "|cffffd27f" or "|cff8a8a8a") .. step.character .. ":|r"
  end
  parts[#parts + 1] = (done and "|cff8a8a8a" or "|cffe8e0cf") .. tostring(step.text) .. "|r"
  local details = {}
  local itemId = Plan.itemId(step)
  if itemId then
    local link = FA.Items.linkFor(step.item)
    local quantity = tonumber(step.quantity)
    local text = quantity and (quantity .. " x " .. link) or link
    if quantity and Plan.isMine(step) and step.kind ~= "mail" and not done then
      local have = tonumber((Core.try(GetItemCount, itemId, true))) or 0
      text = text .. string.format(" |cff8a8a8a(have %d)|r", have)
    end
    details[#details + 1] = text
  end
  if type(step.skillId) == "number" and type(step.skillRank) == "number" then
    local rank = Plan.isMine(step) and not done and Plan.skillRank(step.skillId)
    details[#details + 1] = rank and string.format("skill %d / %d", rank, step.skillRank) or ("skill " .. step.skillRank)
  end
  if step.kind == "collect" and type(step.mailFrom) == "string" then
    details[#details + 1] = "from |cffffd27f" .. step.mailFrom .. "|r"
  end
  if step.kind == "mail" then
    local sent = plan.sent and plan.sent[index]
    local target = "to |cffffd27f" .. tostring(step.mailTo) .. "|r"
    if tonumber(step.moneyCopper) then target = target .. " " .. money(step.moneyCopper) end
    if sent and sent > 0 and not done then target = target .. string.format(" |cff8a8a8a(sent %d)|r", sent) end
    details[#details + 1] = target
  end
  if tonumber(step.location) then
    local point = FA.Map.pointOf(plan, step.location)
    if point then details[#details + 1] = FA.Items.mapLink("plan", point, step.location) end
  end
  local line = table.concat(parts, " ")
  if #details > 0 then line = line .. "  |cffaaaaaa" .. (KIND[step.kind] or "") .. ":|r " .. table.concat(details, ", ") end
  return line
end

function UI.renderPlan()
  if not frame or not frame:IsShown() then return end
  local plan = Plan.active()
  pending = {}
  if not plan then
    title:SetText("No active plan")
    progress:SetText("")
    addLines("Ask the assistant for a plan, then press |cff40c0ff[Make active plan]|r under its answer.", 0.8, 0.8, 0.8)
    finish()
    return
  end
  local done, total = Plan.progress()
  title:SetText(plan.title)
  progress:SetText(string.format("%d / %d done", done, total))
  if Plan.mailOpen() then
    local recipients = Plan.recipients()
    if #recipients > 0 then
      local links = {}
      for i, name in ipairs(recipients) do
        links[i] = "|cff40c0ff|Hfaplan:mail:" .. i .. "|h[Fill letter to " .. name .. "]|h|r"
      end
      addLines("|cffaaaaaaMailbox:|r " .. table.concat(links, "  "))
      addLines(" ")
    end
  end
  for i = 1, #plan.steps do
    addLines(UI.planStepText(plan, i))
  end
  addLines(" ")
  addLines("|cff888888|Hfaplan:clear|h[Close plan]|h|r")
  finish()
end

local function findEntry(entryId)
  local state = FA.Assistant.state
  for _, entry in ipairs(state and state.history or {}) do
    if entry.entryId == entryId then return entry end
  end
end

local function activate(entry)
  if Plan.activate(entry) then
    UI.showPlan()
    UI.render()
  end
end

-- faplan links from chat and the plan window.
function UI.planLink(link)
  local action, argument = FA.Items.planAction(link)
  if action == "activate" then
    local entry = findEntry(argument)
    if not entry then UI.setStatus("This plan is no longer in the conversation."); return end
    local current = Plan.active()
    if current and current.entryId ~= entry.entryId and Plan.progress() > 0 then
      StaticPopup_Show("FOREVERASSISTANT_REPLACE_PLAN", nil, nil, entry)
    else
      activate(entry)
    end
  elseif action == "open" then
    UI.showPlan()
  elseif action == "toggle" then
    Plan.toggle(tonumber(argument))
  elseif action == "mail" then
    local recipient = Plan.recipients()[tonumber(argument) or 0]
    local result, reason = Plan.fillMail(recipient)
    if result then
      if result.noSurname then
        setStatus(string.format(Plan.NO_SURNAME, result.address, result.address))
      else
        setStatus(string.format("Letter to %s: %d attachments%s. Check it and press Send.", result.address, result.attachments,
          result.short and ", some items are missing" or ""))
      end
    else
      setStatus(Plan.REASONS[reason] or tostring(reason))
    end
  elseif action == "clear" then
    StaticPopup_Show("FOREVERASSISTANT_CLEAR_PLAN")
  end
end

StaticPopupDialogs.FOREVERASSISTANT_REPLACE_PLAN = {
  text = "Replace the active plan with this one?\n\nTicks of the current plan are lost.",
  button1 = "Replace", button2 = "Cancel",
  OnAccept = function(_, entry) activate(entry) end,
  timeout = 0, whileDead = true, hideOnEscape = true,
}

StaticPopupDialogs.FOREVERASSISTANT_CLEAR_PLAN = {
  text = "Close the active plan?",
  button1 = "Close plan", button2 = "Cancel",
  OnAccept = function() Plan.clear() end,
  timeout = 0, whileDead = true, hideOnEscape = true,
}

function UI.ensurePlan()
  if frame then return frame end
  frame = T.panel(UIParent, "ForeverAssistantPlanFrame", 0.045, 0.042, 0.038, 16)
  UI.planFrame = frame
  -- Do not register the plan window in UISpecialFrames; Esc must not close it.
  frame:SetFrameStrata("MEDIUM"); frame:SetToplevel(true)
  frame:SetClampedToScreen(true); frame:EnableMouse(true); frame:SetMovable(true); frame:SetResizable(true)
  if frame.SetResizeBounds then frame:SetResizeBounds(MIN_WIDTH, MIN_HEIGHT, MAX_WIDTH, MAX_HEIGHT)
  elseif frame.SetMinResize then frame:SetMinResize(MIN_WIDTH, MIN_HEIGHT); frame:SetMaxResize(MAX_WIDTH, MAX_HEIGHT) end
  local p = prefs()
  frame:SetSize(p.width, p.height)
  if p.point and type(p.x) == "number" and type(p.y) == "number" then
    frame:SetPoint(p.point, UIParent, p.relativePoint or p.point, p.x, p.y)
  else frame:SetPoint("TOPRIGHT", -60, -200) end
  header = CreateFrame("Frame", nil, frame)
  header:SetPoint("TOPLEFT", 8, -8); header:SetPoint("TOPRIGHT", -32, -8); header:SetHeight(44)
  header:EnableMouse(true); header:RegisterForDrag("LeftButton")
  header:SetScript("OnDragStart", function() if not prefs().locked then frame:StartMoving() end end)
  header:SetScript("OnDragStop", function() frame:StopMovingOrSizing(); saveLayout(); UI.renderPlan() end)
  local brand = T.label(header, "ACTIVE PLAN", "GameFontNormalSmall", 0.71, 0.59, 0.37); brand:SetPoint("TOPLEFT", 10, -6)
  title = T.label(header, "", "GameFontNormal", 0.93, 0.77, 0.45)
  T.setContentFont(title, 14)
  title:SetPoint("TOPLEFT", 10, -24); title:SetPoint("TOPRIGHT", -90, -24); title:SetWordWrap(false)
  progress = T.label(header, "", "GameFontDisableSmall"); progress:SetPoint("TOPRIGHT", -4, -26)
  buildIcons()
  local close = CreateFrame("Button", nil, frame, "UIPanelCloseButton"); close:SetPoint("TOPRIGHT", -2, -2)
  T.rule(frame, -56)
  log = CreateFrame("ScrollingMessageFrame", "ForeverAssistantPlanLog", frame)
  log:SetPoint("TOPLEFT", 16, -HEADER); log:SetPoint("BOTTOMRIGHT", -16, FOOTER)
  log:SetFontObject(GameFontHighlight); log:SetJustifyH("LEFT"); log:SetFading(false); log:SetMaxLines(400)
  log:SetInsertMode("BOTTOM"); log:EnableMouseWheel(true); log:SetSpacing(LINE_SPACING)
  log:SetScript("OnMouseWheel", function(_, delta) scroll(delta) end)
  measurer = log:CreateFontString(nil, "OVERLAY"); measurer:Hide()
  log:SetHyperlinksEnabled(true)
  log:SetScript("OnHyperlinkEnter", function(self, link) FA.Items.onEnter(self, link) end)
  log:SetScript("OnHyperlinkLeave", function() FA.Items.onLeave() end)
  log:SetScript("OnHyperlinkClick", function(_, link, text, mouseButton) FA.Items.onClick(link, text, mouseButton, UI.input) end)
  status = T.label(frame, "", "GameFontDisableSmall")
  status:SetPoint("BOTTOMLEFT", 14, 10); status:SetPoint("BOTTOMRIGHT", -24, 10); status:SetWordWrap(false)
  -- Manual resizing sets width and height and disables auto-height until reenabled.
  resize = CreateFrame("Button", nil, frame); resize:SetSize(16, 16); resize:SetPoint("BOTTOMRIGHT", -2, 2)
  resize:SetNormalTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Up")
  resize:SetHighlightTexture("Interface\\ChatFrame\\UI-ChatIM-SizeGrabber-Highlight")
  UI.planResize = resize
  resize:SetScript("OnMouseDown", function(_, key)
    if key ~= "LeftButton" or prefs().locked then return end
    saveLayout()
    sizing = true
    frame:StartSizing("BOTTOMRIGHT")
  end)
  resize:SetScript("OnMouseUp", function()
    frame:StopMovingOrSizing()
    if not sizing then return end
    sizing = false
    local size = prefs()
    size.width = math.floor((tonumber((frame:GetWidth())) or size.width) + 0.5)
    size.height = math.floor((tonumber((frame:GetHeight())) or size.height) + 0.5)
    size.autoHeight = false
    saveLayout()
    UI.applyPlanAppearance()
    Core.ui("refreshSettings")
  end)
  -- Reflow lines while resizing, at most once every 0.05 seconds.
  frame:SetScript("OnSizeChanged", function()
    if not sizing or sizeRenderPending then return end
    sizeRenderPending = true
    local run = function() sizeRenderPending = false; UI.renderPlan() end
    if C_Timer and C_Timer.After then C_Timer.After(0.05, run) else run() end
  end)
  frame:SetScript("OnShow", function(self) self:Raise(); UI.renderPlan() end)
  frame:SetScript("OnHide", function() frame:StopMovingOrSizing(); sizing = false end)
  UI.applyPlanAppearance()
  frame:Hide()
  return frame
end

function UI.showPlan()
  UI.ensurePlan()
  setStatus("")
  if frame:IsShown() then UI.renderPlan() else frame:Show() end
end

function UI.togglePlan()
  UI.ensurePlan()
  if frame:IsShown() then frame:Hide() else UI.showPlan() end
end
