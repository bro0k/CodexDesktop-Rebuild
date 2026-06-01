#!/usr/bin/env node
/**
 * Post-build patch: Force-enable Fast mode (speed selector)
 *
 * The speed selector is gated by authMethod === "chatgpt" checks.
 * API-key users never see it because their authMethod differs.
 *
 * This patch first locates BinaryExpression nodes matching:
 *   X.authMethod !== "chatgpt"
 * inside functions that also reference "fast_mode", and replaces
 * the comparison with !1 (always false), removing the auth gate.
 *
 * It also makes Fast mode render when model metadata exposes
 * additionalSpeedTiers/additional_speed_tiers instead of serviceTiers.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("acorn");
const { locateBundles, relPath, SRC_DIR } = require("./patch-util");

function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object" && item.type) walk(item, visitor);
      }
    } else if (child && typeof child === "object" && child.type) {
      walk(child, visitor);
    }
  }
}

function collectPatches(ast, source) {
  const patches = [];

  walk(ast, (node) => {
    // Match function bodies containing both authMethod and fast_mode
    const isFn =
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression";
    if (!isFn) return;

    const fnSrc = source.slice(node.start, node.end);
    if (!fnSrc.includes("authMethod") || !fnSrc.includes("fast_mode")) return;

    // Inside this function, find: X.authMethod !== `chatgpt`
    walk(node, (child) => {
      if (child.type !== "BinaryExpression" || child.operator !== "!==") return;

      const childSrc = source.slice(child.start, child.end);
      if (!childSrc.includes("authMethod") || !childSrc.includes("chatgpt"))
        return;

      if (childSrc === "!1") return;

      // Avoid duplicate patches at same offset
      if (patches.some((p) => p.start === child.start)) return;

      patches.push({
        id: "fast_mode_auth_gate",
        start: child.start,
        end: child.end,
        replacement: "!1",
        original: childSrc,
      });
    });
  });

  return patches;
}

function pushStringPatch(patches, source, original, replacement, id) {
  if (source.includes(replacement)) return;

  const start = source.indexOf(original);
  if (start === -1) return;

  patches.push({
    id,
    start,
    end: start + original.length,
    replacement,
    original,
  });
}

function collectFastModeAvailabilityPatches(source) {
  const patches = [];

  if (source.includes("additional_speed_tiers?.includes")) return patches;

  const re =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return Array\.isArray\(\2\.serviceTiers\)&&\2\.serviceTiers\.length>0\|\|\2\.additionalSpeedTiers\?\.includes\(([A-Za-z_$][\w$]*)\)===!0\}/;
  const match = re.exec(source);
  if (!match) return patches;

  const [original, fn, model, tier] = match;
  patches.push({
    id: "fast_mode_snake_case_availability",
    start: match.index,
    end: match.index + original.length,
    original,
    replacement: `function ${fn}(${model}){return Array.isArray(${model}.serviceTiers)&&${model}.serviceTiers.length>0||${model}.additionalSpeedTiers?.includes(${tier})===!0||${model}.additional_speed_tiers?.includes(${tier})===!0}`,
  });

  return patches;
}

function collectServiceTierOptionPatches(source) {
  const patches = [];

  if (!source.includes("function Of(") || !source.includes("serviceTiers")) {
    return patches;
  }

  if (!source.includes("function __codexFastModeServiceTiers")) {
    const anchor = "function kf(e){return Of(e)===`fast`}";
    const start = source.indexOf(anchor);
    if (start !== -1) {
      patches.push({
        id: "fast_mode_service_tier_helper",
        start,
        end: start,
        original: "",
        replacement:
          "function __codexFastModeServiceTiers(e){let t=e?.serviceTiers??[],n=e?.additionalSpeedTiers??e?.additional_speed_tiers??[];return n.includes(`fast`)&&!t.some(e=>Of(e.id,e.name)===`fast`)?[...t,{id:`fast`,name:`Fast`,description:null}]:t}",
      });
    }
  }

  pushStringPatch(
    patches,
    source,
    "e?.serviceTiers?.find(e=>e.id===t)??null",
    "__codexFastModeServiceTiers(e).find(e=>e.id===t)??null",
    "fast_mode_lookup_generated_service_tiers",
  );

  pushStringPatch(
    patches,
    source,
    "...(e?.serviceTiers??[]).map(e=>({description:jf(e),iconKind:Of(e.id,e.name),label:Af(e),tier:e,value:e.id}))",
    "...__codexFastModeServiceTiers(e).map(e=>({description:jf(e),iconKind:Of(e.id,e.name),label:Af(e),tier:e,value:e.id}))",
    "fast_mode_render_generated_service_tiers",
  );

  pushStringPatch(
    patches,
    source,
    "e?.serviceTiers?.find(e=>Of(e.id,e.name)===`fast`||e.name.trim().toLowerCase()===`priority`)??null",
    "__codexFastModeServiceTiers(e).find(e=>Of(e.id,e.name)===`fast`||e.name.trim().toLowerCase()===`priority`)??null",
    "fast_mode_find_generated_fast_tier",
  );

  return patches;
}

function collectAllPatches(source) {
  const patches = [
    ...collectFastModeAvailabilityPatches(source),
    ...collectServiceTierOptionPatches(source),
  ];

  if (source.includes("authMethod") && source.includes("fast_mode")) {
    let ast;
    try {
      ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
    } catch {
      ast = null;
    }

    if (ast) patches.push(...collectPatches(ast, source));
  }

  return patches;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const fileArg = args.find((a) => a.startsWith("--file="));
  const platform = args.find((a) =>
    ["mac-arm64", "mac-x64", "win"].includes(a),
  );

  const platforms = platform
    ? [platform]
    : ["mac-arm64", "mac-x64", "win"].filter((p) =>
        fs.existsSync(path.join(SRC_DIR, p, "_asar", "webview", "assets")),
      );

  const targets = fileArg
    ? [{ platform: "local", path: path.resolve(fileArg.slice("--file=".length)) }]
    : [];

  if (!fileArg) {
    for (const plat of platforms) {
      const assetsDir = path.join(SRC_DIR, plat, "_asar", "webview", "assets");
      if (!fs.existsSync(assetsDir)) continue;
      for (const f of fs.readdirSync(assetsDir)) {
        if (!f.endsWith(".js")) continue;
        const fp = path.join(assetsDir, f);
        const src = fs.readFileSync(fp, "utf-8");
        if (
          (src.includes("authMethod") && src.includes("fast_mode")) ||
          src.includes("additionalSpeedTiers") ||
          src.includes("function Of(")
        ) {
          targets.push({ platform: plat, path: fp });
        }
      }
    }
  }

  if (targets.length === 0) {
    console.log("  [skip] No chunk contains fast_mode gate logic");
    return;
  }

  let totalPatched = 0;

  for (const bundle of targets) {
    const source = fs.readFileSync(bundle.path, "utf-8");
    const patches = collectAllPatches(source);

    if (patches.length === 0) continue;

    console.log(`  [${bundle.platform}] ${relPath(bundle.path)}`);

    if (isCheck) {
      totalPatched += patches.length;
      for (const p of patches) {
        console.log(`    [?] ${p.id} @ ${p.start}`);
      }
      continue;
    }

    patches.sort((a, b) => b.start - a.start);

    let code = source;
    for (const p of patches) {
      console.log(`    * ${p.id} @ ${p.start}`);
      code = code.slice(0, p.start) + p.replacement + code.slice(p.end);
    }

    fs.writeFileSync(bundle.path, code, "utf-8");
    totalPatched += patches.length;
  }

  if (totalPatched > 0) {
    const action = isCheck ? "would be applied" : "applied";
    console.log(`  [ok] ${totalPatched} Fast mode patch(es) ${action}`);
  } else {
    console.log("  [ok] Fast mode patches already applied or absent");
  }
}

main();
