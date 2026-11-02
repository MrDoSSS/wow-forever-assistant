-- Appearance, keybindings and automatic context settings.
local _, FA = ...
local UI, Core = FA.UI, FA.Core
local T = UI.Theme
local ACTION = "FOREVERASSISTANT_TOGGLE"
-- Scrollable content height and wheel step in pixels.
local CONTENT_HEIGHT, WHEEL_STEP = 715, 40
local GROUPS = {
  character = { "Character", "Class, level and money" },
  equipment = { "Equipment", "Currently equipped items" },
  quests = { "Quests", "Quest log and objectives" },
  talents = { "Talents", "Your current talent build" },
  position = { "Position", "Zone and map coordinates" },
  bags = { "Bags", "Items and quantities" },
  professions = { "Professions", "Skills and current ranks" },
  prices = { "Auction prices", "Local Auctionator data" },
}

local function inCombat() return Core.try(InCombatLockdown) end

-- Check conflicts before changing the current keybinding set.
function UI.assignBinding(key, replace)
  if inCombat() then return false, "Leave combat to change a shortcut." end
  if type(SetBinding) ~= "function" or type(SaveBindings) ~= "function" or type(GetBindingKey) ~= "function" then
    return false, "Use the game's Key Bindings > AddOns to set a shortcut."
  end
  local conflict = key and Core.try(GetBindingAction, key)
  if conflict and conflict ~= "" and conflict ~= ACTION and not replace then return false, "conflict", conflict end
  local first, second = GetBindingKey(ACTION)
  if key and not Core.try(SetBinding, key, ACTION) then return false, "The client could not assign that key." end
  for _, old in ipairs({ first, second }) do
    if old ~= key then Core.try(SetBinding, old) end
  end
  local ok = pcall(SaveBindings, Core.try(GetCurrentBindingSet) or 1)
  if not ok then
    if key then Core.try(SetBinding, key, conflict ~= "" and conflict or nil) end
    if first then Core.try(SetBinding, first, ACTION) end
    if second then Core.try(SetBinding, second, ACTION) end
    return false, "The client could not save the shortcut."
  end
  return true
end

function UI.buildSettings(parent)
  local panel = CreateFrame("Frame", nil, parent)
  panel:SetAllPoints()
  UI.settings = panel
  -- Sections scroll by wheel and the right scrollbar; keep the status line at the bottom.
  local scroll = CreateFrame("ScrollFrame", nil, panel)
  scroll:SetPoint("TOPLEFT", 0, 0); scroll:SetPoint("BOTTOMRIGHT", -12, 44)
  local body = CreateFrame("Frame", nil, scroll)
  body:SetSize(math.max(1, (tonumber((scroll:GetWidth())) or 0)), CONTENT_HEIGHT)
  scroll:SetScrollChild(body)
  panel.scroll, panel.body = scroll, body
  local bar = CreateFrame("Slider", nil, panel)
  bar:SetOrientation("VERTICAL"); bar:SetWidth(6)
  bar:SetPoint("TOPRIGHT", panel, "TOPRIGHT", -4, -60); bar:SetPoint("BOTTOMRIGHT", panel, "BOTTOMRIGHT", -4, 48)
  local track = bar:CreateTexture(nil, "BACKGROUND"); track:SetAllPoints(); track:SetColorTexture(1, 1, 1, 0.06)
  local thumb = bar:CreateTexture(nil, "OVERLAY"); thumb:SetColorTexture(0.88, 0.76, 0.51, 0.55); thumb:SetSize(6, 36)
  bar:SetThumbTexture(thumb); bar:SetValueStep(1)
  panel.bar = bar
  local function maxScroll()
    return math.max(0, CONTENT_HEIGHT - (tonumber((scroll:GetHeight())) or 0))
  end
  function panel.scrollTo(offset)
    offset = math.max(0, math.min(maxScroll(), offset))
    scroll:SetVerticalScroll(offset)
    panel.offset = offset
    bar:SetMinMaxValues(0, maxScroll()); bar:SetValue(offset)
    if maxScroll() > 0 then bar:Show() else bar:Hide() end
  end
  panel.offset = 0
  scroll:EnableMouseWheel(true)
  scroll:SetScript("OnMouseWheel", function(_, delta) panel.scrollTo(panel.offset - delta * WHEEL_STEP) end)
  scroll:SetScript("OnSizeChanged", function(self, width)
    body:SetWidth(math.max(1, tonumber(width) or (tonumber((self:GetWidth())) or 1)))
    panel.scrollTo(panel.offset)
  end)
  bar:SetScript("OnValueChanged", function(_, value)
    if value and math.floor(value + 0.5) ~= panel.offset then panel.scrollTo(math.floor(value + 0.5)) end
  end)
  local heading = T.label(body, "Settings", "GameFontNormalLarge", 0.91, 0.75, 0.44)
  heading:SetPoint("TOPLEFT", 22, -20)
  local back = T.button(body, "Back to chat", 110, function() UI.showSettings(false) end)
  back:SetPoint("TOPRIGHT", -22, -15)
  T.rule(body, -56)

  local appearance = T.label(body, "APPEARANCE", "GameFontNormalSmall", 0.74, 0.59, 0.34)
  appearance:SetPoint("TOPLEFT", 24, -73)
  panel.controls = {}
  local function stepper(label, key, y, step, minimum, maximum, format, store, apply, id)
    store, apply = store or UI.preferences, apply or UI.applyAppearance
    local title = T.label(body, label, "GameFontHighlightSmall")
    title:SetPoint("TOPLEFT", 24, y - 7)
    local value = T.label(body, "", "GameFontNormalSmall")
    value:SetPoint("TOPRIGHT", -66, y - 7)
    value:SetWidth(54); value:SetJustifyH("CENTER")
    local function change(delta)
      local prefs = store()
      prefs[key] = math.max(minimum, math.min(maximum, math.floor((prefs[key] + delta) * 100 + 0.5) / 100))
      apply(); UI.refreshSettings()
    end
    local minus = T.button(body, "-", 26, function() change(-step) end)
    minus:SetPoint("TOPRIGHT", -124, y)
    local plus = T.button(body, "+", 26, function() change(step) end)
    plus:SetPoint("TOPRIGHT", -32, y)
    panel.controls[id or key] = { key = key, store = store, label = value, format = format, minus = minus, plus = plus, minimum = minimum, maximum = maximum }
  end
  stepper("Window scale", "scale", -94, 0.05, 0.65, 1.25, function(n) return string.format("%d%%", math.floor(n * 100 + 0.5)) end)
  stepper("Chat text size", "fontSize", -126, 1, 12, 20, function(n) return tostring(n) end)
  stepper("Background opacity", "opacity", -158, 0.05, 0.65, 1, function(n) return string.format("%d%%", math.floor(n * 100 + 0.5)) end)
  local lock = CreateFrame("CheckButton", nil, body, "UICheckButtonTemplate")
  lock:SetSize(26, 26); lock:SetPoint("TOPLEFT", 20, -191)
  local lockLabel = T.label(lock, "Lock window position and size")
  lockLabel:SetPoint("LEFT", lock, "RIGHT", 2, 0)
  lock:SetScript("OnClick", function(self) UI.preferences().locked = self:GetChecked() and true or false; UI.applyAppearance() end)
  panel.lock = lock
  local reset = T.button(body, "Reset layout", 100, function()
    local prefs = UI.preferences()
    for key, value in pairs(T.defaults) do prefs[key] = value end
    prefs.point, prefs.x, prefs.y = nil, nil, nil
    UI.frame:ClearAllPoints(); UI.frame:SetPoint("CENTER")
    UI.applyAppearance(); UI.refreshSettings()
  end)
  reset:SetPoint("TOPRIGHT", -32, -191)
  T.rule(body, -226)

  local shortcut = T.label(body, "OPEN / CLOSE CHAT", "GameFontNormalSmall", 0.74, 0.59, 0.34)
  shortcut:SetPoint("TOPLEFT", 24, -241)
  local capture = T.button(body, "Not bound", 180, nil, true)
  capture:SetPoint("TOPLEFT", 24, -264)
  local unbind = T.button(body, "Unbind", 80, function()
    local ok, reason = UI.assignBinding(nil)
    if not ok then UI.setStatus(reason) end
    UI.refreshSettings()
  end)
  unbind:SetPoint("LEFT", capture, "RIGHT", 8, 0)
  panel.capture = capture
  local hint = T.label(body, "Click, then press a key combination. Esc cancels.", "GameFontDisableSmall")
  hint:SetPoint("TOPLEFT", 24, -299)

  local catcher = CreateFrame("Frame", nil, panel)
  catcher:SetAllPoints(); catcher:SetFrameLevel(panel:GetFrameLevel() + 10)
  catcher:EnableKeyboard(true)
  if catcher.SetPropagateKeyboardInput then catcher:SetPropagateKeyboardInput(false) end
  catcher:Hide()
  local function cancelCapture()
    catcher:Hide(); panel.capturing = false; UI.refreshSettings()
  end
  panel.cancelCapture = cancelCapture
  capture:SetScript("OnClick", function()
    if inCombat() then UI.setStatus("Leave combat to change a shortcut."); return end
    UI.input:ClearFocus()
    panel.capturing = true
    capture:SetText("Press a key...")
    catcher:Show()
  end)
  catcher:SetScript("OnKeyDown", function(_, key)
    if key == "ESCAPE" then cancelCapture(); return end
    if key == "LSHIFT" or key == "RSHIFT" or key == "LCTRL" or key == "RCTRL" or key == "LALT" or key == "RALT" or key == "UNKNOWN" then return end
    local combo = (Core.try(IsAltKeyDown) and "ALT-" or "") .. (Core.try(IsControlKeyDown) and "CTRL-" or "") .. (Core.try(IsShiftKeyDown) and "SHIFT-" or "") .. key
    cancelCapture()
    local ok, reason, action = UI.assignBinding(combo)
    if reason == "conflict" then
      StaticPopupDialogs.FOREVERASSISTANT_BINDING = {
        text = combo .. " is assigned to " .. (_G["BINDING_NAME_" .. action] or action) .. ". Replace it?",
        button1 = "Replace", button2 = "Cancel", timeout = 0, whileDead = true, hideOnEscape = true,
        OnAccept = function()
          local assigned, errorText = UI.assignBinding(combo, true)
          if not assigned then UI.setStatus(errorText) end
          UI.refreshSettings()
        end,
      }
      StaticPopup_Show("FOREVERASSISTANT_BINDING")
    elseif not ok then UI.setStatus(reason) end
    UI.refreshSettings()
  end)
  panel:SetScript("OnHide", cancelCapture)
  panel:RegisterEvent("UPDATE_BINDINGS")
  panel:RegisterEvent("PLAYER_REGEN_DISABLED")
  panel:SetScript("OnEvent", function(_, event)
    if event == "PLAYER_REGEN_DISABLED" then cancelCapture() end
    UI.refreshSettings()
  end)
  T.rule(body, -324)

  local context = T.label(body, "AUTOMATIC CONTEXT", "GameFontNormalSmall", 0.74, 0.59, 0.34)
  context:SetPoint("TOPLEFT", 24, -339)
  panel.checks = {}
  for i, name in ipairs(FA.Context.GROUPS) do
    local group = name
    local check = CreateFrame("CheckButton", nil, body, "UICheckButtonTemplate")
    check:SetSize(26, 26)
    check:SetPoint("TOPLEFT", body, "TOPLEFT", (i % 2 == 1) and 20 or 276, -363 - math.floor((i - 1) / 2) * 39)
    local label = T.label(check, GROUPS[group][1], "GameFontHighlightSmall")
    label:SetPoint("LEFT", check, "RIGHT", 2, 5)
    local detail = T.label(check, GROUPS[group][2], "GameFontDisableSmall")
    detail:SetPoint("TOPLEFT", label, "BOTTOMLEFT", 0, -3)
    check:SetScript("OnClick", function(self)
      if not FA.Assistant.state then self:SetChecked(false); return end
      if self:GetChecked() then
        FA.Assistant.setGroup(group, true, "keep")
      else
        self:SetChecked(true)
        StaticPopupDialogs.FOREVERASSISTANT_DISABLE_GROUP = {
          text = "Disable \"" .. GROUPS[group][1] .. "\"? Data already sent stays in conversation memory unless you start over.",
          button1 = "Keep memory", button2 = "Cancel", button3 = "Start over",
          OnAccept = function() FA.Assistant.setGroup(group, false, "keep"); UI.refreshSettings() end,
          OnAlt = function() FA.Assistant.setGroup(group, false, "reset"); UI.refreshSettings() end,
          timeout = 0, whileDead = true, hideOnEscape = true,
        }
        StaticPopup_Show("FOREVERASSISTANT_DISABLE_GROUP")
      end
      UI.refreshSettings()
    end)
    panel.checks[group] = check
  end
  T.rule(body, -536)
  local planHeading = T.label(body, "PLAN WINDOW", "GameFontNormalSmall", 0.74, 0.59, 0.34)
  planHeading:SetPoint("TOPLEFT", 24, -551)
  local function applyPlan() UI.applyPlanAppearance() end
  local percent = function(n) return string.format("%d%%", math.floor(n * 100 + 0.5)) end
  stepper("Plan background", "opacity", -572, 0.1, 0, 1, percent, UI.planPreferences, applyPlan, "plan.opacity")
  stepper("Plan text size", "fontSize", -604, 1, 10, 20, tostring, UI.planPreferences, applyPlan, "plan.fontSize")
  local planLock = CreateFrame("CheckButton", nil, body, "UICheckButtonTemplate")
  planLock:SetSize(26, 26); planLock:SetPoint("TOPLEFT", 20, -637)
  local planLockLabel = T.label(planLock, "Lock plan window position and size")
  planLockLabel:SetPoint("LEFT", planLock, "RIGHT", 2, 0)
  planLock:SetScript("OnClick", function(self) UI.planPreferences().locked = self:GetChecked() and true or false; UI.applyPlanAppearance() end)
  panel.planLock = planLock
  local planAuto = CreateFrame("CheckButton", nil, body, "UICheckButtonTemplate")
  planAuto:SetSize(26, 26); planAuto:SetPoint("TOPLEFT", 20, -670)
  local planAutoLabel = T.label(planAuto, "Fit plan height to its steps (resizing turns it off)")
  planAutoLabel:SetPoint("LEFT", planAuto, "RIGHT", 2, 0)
  planAuto:SetScript("OnClick", function(self)
    UI.planPreferences().autoHeight = self:GetChecked() and true or false
    UI.applyPlanAppearance()
  end)
  panel.planAuto = planAuto
  local planReset = T.button(body, "Reset plan layout", 130, function()
    local prefs = UI.planPreferences()
    prefs.point, prefs.relativePoint, prefs.x, prefs.y = nil, nil, nil, nil
    for _, key in ipairs({ "width", "height", "autoHeight" }) do prefs[key] = UI.PLAN_DEFAULTS[key] end
    if UI.planFrame then UI.planFrame:ClearAllPoints(); UI.planFrame:SetPoint("TOPRIGHT", -60, -200) end
    UI.applyPlanAppearance(); UI.refreshSettings()
  end)
  planReset:SetPoint("TOPRIGHT", -32, -637)
  panel.feedback = T.label(panel, UI.lastStatus or "Settings are saved automatically.", "GameFontDisableSmall")
  panel.feedback:SetPoint("BOTTOMLEFT", 24, 12)
  panel.feedback:SetPoint("BOTTOMRIGHT", -24, 12)
  panel.feedback:SetHeight(28)
  panel:Hide()
  return panel
end

function UI.refreshSettings()
  local panel = UI.settings
  if not panel then return end
  local prefs = UI.preferences()
  for _, control in pairs(panel.controls) do
    local value = control.store()[control.key]
    control.label:SetText(control.format(value))
    T.enabled(control.minus, value > control.minimum)
    T.enabled(control.plus, value < control.maximum)
  end
  panel.lock:SetChecked(prefs.locked)
  panel.planLock:SetChecked(UI.planPreferences().locked)
  panel.planAuto:SetChecked(UI.planPreferences().autoHeight)
  panel.scrollTo(panel.offset)
  if not panel.capturing then panel.capture:SetText(UI.bindingText()) end
  local enabled = {}
  local state = FA.Assistant.state
  if state then for _, group in ipairs(state.policy.enabledGroups) do enabled[group] = true end end
  for name, check in pairs(panel.checks) do
    check:SetChecked(enabled[name] or false)
    T.enabled(check, state ~= nil)
  end
  if UI.shortcutHint then UI.shortcutHint:SetText("/fa  |  " .. UI.bindingText()) end
end
