-- Shared theme: game textures, bronze borders and subdued dark panels.
local _, FA = ...
local UI = FA.UI
local Theme = {}
UI.Theme = Theme

Theme.gold = { 0.86, 0.69, 0.39 }
Theme.muted = { 0.59, 0.59, 0.55 }
-- Use a custom font because enUS GameFontHighlight does not guarantee Cyrillic glyphs.
-- It has no Korean or Chinese, so those clients keep their own font, which has their
-- script; the bridge fits reply text to the same choice (bridge/src/domain/glyphs.ts).
Theme.addonFont = "Interface\\AddOns\\ForeverAssistant\\Fonts\\NotoSans-Regular.ttf"
Theme.CLIENT_FONT_LOCALES = { koKR = true, zhCN = true, zhTW = true }

function Theme.fontFor(locale)
  if not Theme.CLIENT_FONT_LOCALES[locale] then return Theme.addonFont end
  if type(STANDARD_TEXT_FONT) == "string" and STANDARD_TEXT_FONT ~= "" then return STANDARD_TEXT_FONT end
  local path = GameFontHighlight and FA.Core.try(GameFontHighlight.GetFont, GameFontHighlight)
  return type(path) == "string" and path or Theme.addonFont
end

Theme.contentFont = Theme.fontFor(FA.Core.locale())
Theme.defaults = { scale = 1, fontSize = 14, opacity = 0.96, locked = false, width = 860, height = 660 }

function Theme.setContentFont(region, size)
  return not not FA.Core.try(region.SetFont, region, Theme.contentFont, size, "")
end

function UI.preferences()
  ForeverAssistantDB = ForeverAssistantDB or {}
  ForeverAssistantDB.ui = ForeverAssistantDB.ui or {}
  local prefs = ForeverAssistantDB.ui
  for key, value in pairs(Theme.defaults) do
    if type(prefs[key]) ~= type(value) then prefs[key] = value end
  end
  prefs.scale = math.max(0.65, math.min(1.25, prefs.scale))
  prefs.fontSize = math.max(12, math.min(20, prefs.fontSize))
  prefs.opacity = math.max(0.65, math.min(1, prefs.opacity))
  prefs.width = math.max(760, math.min(1200, prefs.width))
  prefs.height = math.max(660, math.min(900, prefs.height))
  return prefs
end

function Theme.texture(parent, layer, r, g, b, a)
  local texture = parent:CreateTexture(nil, layer or "ARTWORK")
  texture:SetTexture("Interface\\Buttons\\WHITE8X8")
  texture:SetVertexColor(r, g, b, a or 1)
  return texture
end

function Theme.panel(parent, name, r, g, b, edge)
  local panel = CreateFrame("Frame", name, parent, BackdropTemplateMixin and "BackdropTemplate" or nil)
  if panel.SetBackdrop then
    panel:SetBackdrop({ bgFile = "Interface\\Buttons\\WHITE8X8", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
      edgeSize = edge or 12, insets = { left = 3, right = 3, top = 3, bottom = 3 } })
    panel:SetBackdropColor(r or 0.055, g or 0.055, b or 0.06, 1)
    panel:SetBackdropBorderColor(0.35, 0.29, 0.19, 1)
  end
  return panel
end

function Theme.label(parent, text, font, r, g, b)
  local label = parent:CreateFontString(nil, "OVERLAY", font or "GameFontHighlightSmall")
  label:SetText(text)
  label:SetJustifyH("LEFT")
  label:SetTextColor(r or 0.85, g or 0.84, b or 0.78)
  return label
end

function Theme.rule(parent, y)
  local line = Theme.texture(parent, "ARTWORK", 0.64, 0.49, 0.26, 0.28)
  line:SetHeight(1)
  line:SetPoint("TOPLEFT", 20, y)
  line:SetPoint("TOPRIGHT", -20, y)
  return line
end

function Theme.button(parent, label, width, onClick, primary)
  local b = CreateFrame("Button", nil, parent, BackdropTemplateMixin and "BackdropTemplate" or nil)
  b:SetSize(width, 28)
  if b.SetBackdrop then
    b:SetBackdrop({ bgFile = "Interface\\Buttons\\WHITE8X8", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
      edgeSize = 10, insets = { left = 2, right = 2, top = 2, bottom = 2 } })
  end
  b.label = Theme.label(b, label, "GameFontNormalSmall")
  b.label:SetPoint("CENTER")
  b.label:SetTextColor(primary and 1 or 0.81, primary and 0.83 or 0.76, primary and 0.48 or 0.64)
  function b:SetText(text) self.label:SetText(text) end
  function b:paint(hover)
    if not self.SetBackdropColor then return end
    self:SetBackdropColor(primary and 0.25 or 0.10, primary and 0.17 or 0.10, primary and 0.07 or 0.105, 1)
    self:SetBackdropBorderColor(hover and 0.90 or 0.46, hover and 0.70 or 0.36, hover and 0.38 or 0.22, 1)
  end
  b:paint(false)
  b:SetScript("OnEnter", function(self) self:paint(true) end)
  b:SetScript("OnLeave", function(self) self:paint(false) end)
  b:SetScript("OnClick", onClick)
  return b
end

function Theme.enabled(button, enabled)
  if enabled then button:Enable(); button:SetAlpha(1) else button:Disable(); button:SetAlpha(0.4) end
end

function UI.bindingText()
  local first, second = FA.Core.try(GetBindingKey, "FOREVERASSISTANT_TOGGLE")
  local function pretty(key)
    return FA.Core.try(GetBindingText, key, "KEY_") or key
  end
  if first and second then return pretty(first) .. " / " .. pretty(second) end
  return first and pretty(first) or "Not bound"
end
