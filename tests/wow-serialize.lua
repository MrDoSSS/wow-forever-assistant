-- Write client-style SavedVariables: ["key"] = value,
-- arrays as values with -- [n] comments. Used by bridge alt-reader tests.
local function quote(s)
  local escaped = s:gsub("\\", "\\\\"):gsub('"', '\\"'):gsub("\n", "\\n")
  return '"' .. escaped .. '"'
end

local function isArray(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  return n > 0 and n == #t
end

function WowSerialize(value, indent)
  indent = indent or ""
  local kind = type(value)
  if kind == "string" then return quote(value) end
  if kind == "number" or kind == "boolean" then return tostring(value) end
  if kind ~= "table" then error("cannot serialize " .. kind) end
  local inner = indent .. "\t"
  local lines = { "{" }
  if isArray(value) then
    for i, v in ipairs(value) do lines[#lines + 1] = inner .. WowSerialize(v, inner) .. ", -- [" .. i .. "]" end
  else
    local keys = {}
    for k in pairs(value) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    for _, k in ipairs(keys) do
      local key = type(k) == "string" and ("[" .. quote(k) .. "]") or ("[" .. tostring(k) .. "]")
      lines[#lines + 1] = inner .. key .. " = " .. WowSerialize(value[k], inner) .. ","
    end
  end
  lines[#lines + 1] = indent .. "}"
  return table.concat(lines, "\n")
end

function WowSavedVariables(name)
  return "\n" .. name .. " = " .. WowSerialize(_G[name]) .. "\n"
end
