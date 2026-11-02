-- Wrap list text into individual lines. ScrollingMessageFrame scrolls messages,
-- not text lines, so one long reply would scroll past in a single step.
-- Add each line as a separate message and wrap to the list's width.
-- measure(text) returns pixel width using FontString:GetStringWidth;
-- without a measure function, split only at explicit newlines.
-- Never split |c...|H...|h[...]|h|r links; carry an open |cAARRGGBB color
-- onto the next line.
local _, FA = ...
local Wrap = {}
FA.Wrap = Wrap

local LINK_PATTERNS = {
  "^|c%x%x%x%x%x%x%x%x|H.-|h.-|h|r",
  "^|cn[%w_]+:|H.-|h.-|h|r",
  "^|H.-|h.-|h",
}

-- Words, whitespace and links as indivisible tokens.
local function tokens(text)
  local list, i = {}, 1
  while i <= #text do
    local rest = string.sub(text, i)
    local token
    for _, pattern in ipairs(LINK_PATTERNS) do
      token = string.match(rest, pattern)
      if token then break end
    end
    if not token then
      if string.match(rest, "^%s") then
        token = string.match(rest, "^%s+")
      else
        -- Word up to whitespace or the start of a link.
        local stop = #rest
        local space = string.find(rest, "%s")
        if space then stop = space - 1 end
        local link = string.find(rest, "|[cH]", 2)
        if link and link - 1 < stop then stop = link - 1 end
        token = string.sub(rest, 1, stop)
      end
    end
    list[#list + 1] = token
    i = i + #token
  end
  return list
end

-- Last unclosed non-link color: |cAARRGGBB with no later |r.
local function openColor(line)
  local color
  for code, rest in string.gmatch(line, "(|c%x%x%x%x%x%x%x%x)()") do
    color = code
    local closed = string.find(line, "|r", rest, true)
    if closed then color = nil end
  end
  return color
end

local function wrapParagraph(paragraph, width, measure, out)
  if paragraph == "" then out[#out + 1] = ""; return end
  local line, prefix = "", ""
  for _, token in ipairs(tokens(paragraph)) do
    local isSpace = string.match(token, "^%s+$") ~= nil
    local candidate = line .. token
    if line ~= "" and not isSpace and measure(prefix .. candidate) > width then
      local trimmed = string.gsub(line, "%s+$", "")
      local color = openColor(prefix .. trimmed)
      out[#out + 1] = prefix .. trimmed .. (color and "|r" or "")
      prefix = color or ""
      line = token
    elseif not (line == "" and isSpace) then
      line = candidate
    end
  end
  out[#out + 1] = prefix .. string.gsub(line, "%s+$", "")
end

function Wrap.lines(text, width, measure)
  local out = {}
  text = tostring(text or "")
  local usable = type(width) == "number" and width > 0 and type(measure) == "function"
  for paragraph in string.gmatch(text .. "\n", "(.-)\r?\n") do
    if usable then
      wrapParagraph(paragraph, width, function(s) return tonumber((measure(s))) or 0 end, out)
    else
      out[#out + 1] = paragraph
    end
  end
  return out
end
