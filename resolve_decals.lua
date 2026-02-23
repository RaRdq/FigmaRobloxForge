-- Paste this into Studio Command Bar (View > Command Bar)
-- It resolves Decal IDs to real Image texture IDs
local decalIds = {75599586638388, 102029438803696, 130092042810799, 91084731391980, 76205337130898, 103525593667385, 137947329530049, 79725287851552, 129958370408849, 108629708282691, 119103427779702, 129180607515646, 96592737556682, 81815134423266, 127799653860188, 110270753012753, 120052494523203, 92589194554673, 75639693523008, 121502930034114, 92175180558642, 106608433861089}
local mapping = {}
for _, did in ipairs(decalIds) do
  local ok, objs = pcall(function() return game:GetObjects("rbxassetid://"..tostring(did)) end)
  if ok and objs and #objs > 0 then
    local obj = objs[1]
    local tex = obj:IsA("Decal") and obj.Texture or (obj:FindFirstChildOfClass("Decal") and obj:FindFirstChildOfClass("Decal").Texture or "NONE")
    mapping[did] = tex
    print(did.." -> "..tex)
    obj:Destroy()
  else
    print(did.." -> FAILED")
  end
end
print("=== DONE ===")
