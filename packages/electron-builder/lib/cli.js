"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { randomUUID } = require("node:crypto");

const DEFAULT_TARGETS = Object.freeze({
  win: ["nsis"],
  linux: ["deb", "rpm"],
  mac: ["dmg", "pkg"],
});
const SUPPORTED_TARGETS = Object.freeze({
  win: new Set(["nsis", "dir"]),
  linux: new Set(["deb", "rpm", "dir"]),
  mac: new Set(["dmg", "pkg", "dir"]),
});
const TEMPORARY_CONFIGS = new Map();

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const packageMetadata = dependencies.packageMetadata || require("../package.json");
  const builder = dependencies.builder || loadElectronBuilder();
  const parser = builder.createYargs();
  builder.configureBuildCommand(parser);
  parser
    .scriptName("minitron-builder")
    .usage("Usage: minitron-builder [electron-builder options]")
    .help()
    .version(packageMetadata.version)
    .example("minitron-builder --linux deb rpm", "Build Linux installers")
    .strict()
    .exitProcess(false);

  const parsed = await parser.parseAsync(argv);
  if (parsed.help || parsed.version) return { handled: true, parsed };
  if (parsed.prepackaged !== undefined && parsed.prepackaged !== false) {
    throw new Error("--prepackaged is not supported because it skips Minitron's afterPack conversion; package the app normally instead");
  }

  if (parsed.publish === undefined) parsed.publish = "never";
  const buildOptions = builder.normalizeOptions(parsed);
  const projectDir = path.resolve(buildOptions.projectDir || process.cwd());
  buildOptions.projectDir = projectDir;

  const projectPackage = dependencies.readProjectPackage
    ? await dependencies.readProjectPackage(projectDir)
    : await readProjectPackage(projectDir);
  const resolveConfig = dependencies.resolveBuilderConfig || resolveBuilderConfiguration;
  const resolvedConfig = await resolveConfig({
    projectDir,
    configOption: buildOptions.config,
    packageJson: projectPackage,
    appBuilder: dependencies.appBuilder,
    readConfigFile: dependencies.readConfigFile,
  });
  const baseConfig = applyDefaultTargets(resolvedConfig);
  const minitronOptions = resolveMinitronOptions(
    projectPackage.minitron,
    dependencies.env || process.env,
    projectDir,
  );
  const withMinitron = dependencies.withMinitron || require("../index").withMinitron;
  const augmentedConfig = withMinitron(baseConfig, minitronOptions);
  const appBuilder = dependencies.appBuilder || loadAppBuilder();
  validateBuildTargets(buildOptions.targets, augmentedConfig, appBuilder.Platform);

  const temporaryConfig = await createTemporaryConfig(augmentedConfig);
  buildOptions.config = temporaryConfig.path;
  buildOptions.publish = buildOptions.publish === undefined ? "never" : buildOptions.publish;
  try {
    const build = dependencies.build || builder.build;
    return await build(buildOptions);
  } finally {
    await temporaryConfig.cleanup();
  }
}

function loadElectronBuilder() {
  return require("electron-builder/out/builder");
}

function loadAppBuilder() {
  return {
    ...require("app-builder-lib/out/util/config"),
    Platform: require("app-builder-lib").Platform,
  };
}

async function readProjectPackage(projectDir) {
  const filename = path.join(projectDir, "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Project package.json was not found: ${filename}`);
    if (error instanceof SyntaxError) throw new Error(`Project package.json is not valid JSON: ${filename}`);
    throw error;
  }
  if (!isRecord(packageJson)) throw new Error(`Project package.json must contain an object: ${filename}`);
  return packageJson;
}

async function resolveBuilderConfiguration({ projectDir, configOption, packageJson, appBuilder, readConfigFile }) {
  const builderConfig = appBuilder || loadAppBuilder();
  const configReader = readConfigFile || require("read-config-file");
  const normalized = normalizeBuilderConfigOption(configOption);
  const packageMetadata = { get value() { return Promise.resolve(packageJson); } };
  const request = {
    packageKey: "build",
    configFilename: "electron-builder",
    projectDir,
    packageMetadata,
  };

  let loaded;
  if (normalized.configPath !== null) {
    loaded = await readConfigPath(normalized.configPath, projectDir, request, configReader);
  } else if (packageJson.build !== undefined && packageJson.build !== null) {
    loaded = { result: packageJson.build, configFile: null };
  } else {
    loaded = await configReader.findAndReadConfig(request);
    if (loaded === null) {
      const modulePath = path.join(projectDir, "electron-builder.mjs");
      try {
        await fs.access(modulePath);
        loaded = { result: await loadMjsConfig(modulePath, request), configFile: modulePath };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  const config = cloneConfig(loaded ? loaded.result : {});
  if (!isRecord(config)) throw new Error("electron-builder configuration must export an object");
  mergeConfigFromOptions(config, normalized.configOverrides, require("builder-util").deepAssign);
  await applyImplicitPreset(config, packageJson, projectDir);

  const parents = [];
  await collectParentConfigs(config, request, configReader, parents);
  return builderConfig.doMergeConfigs([...parents, config]);
}

function normalizeBuilderConfigOption(value) {
  if (typeof value === "string") return { configPath: value, configOverrides: null };
  if (value == null) return { configPath: null, configOverrides: null };
  if (!isRecord(value)) throw new Error("electron-builder --config options must resolve to an object or config path");

  const configOverrides = cloneConfig(value);
  if (typeof configOverrides.extends === "string" && configOverrides.extends.includes(".")) {
    const configPath = configOverrides.extends;
    delete configOverrides.extends;
    return { configPath, configOverrides };
  }
  return { configPath: null, configOverrides };
}

async function readConfigPath(configPath, projectDir, request, configReader) {
  const absolutePath = path.resolve(projectDir, configPath);
  if (path.extname(absolutePath).toLowerCase() === ".mjs") {
    return { result: await loadMjsConfig(absolutePath, request), configFile: absolutePath };
  }
  return configReader.loadParentConfig(request, `file:${absolutePath}`);
}

async function loadMjsConfig(filename, request) {
  const loaded = await import(pathToFileURL(filename).href);
  let config = Object.prototype.hasOwnProperty.call(loaded, "default") ? loaded.default : { ...loaded };
  if (typeof config === "function") config = await config(request);
  if (!isRecord(config)) throw new Error(`electron-builder ESM config must export an object: ${filename}`);
  return config;
}

function mergeConfigFromOptions(config, configFromOptions, deepAssign) {
  if (configFromOptions == null) return;
  const overrides = cloneConfig(configFromOptions);
  const publish = Array.isArray(config.publish) ? overrides.publish : null;
  if (publish != null) delete overrides.publish;
  deepAssign(config, overrides);
  if (publish != null) {
    if (config.publish.length === 0) config.publish = publish;
    else Object.assign(config.publish[0], publish);
  }
}

async function applyImplicitPreset(config, packageJson, projectDir) {
  if (config.extends !== undefined && config.extends !== null) return;
  const dependencies = packageJson.dependencies || {};
  const devDependencies = packageJson.devDependencies || {};
  if ("react-scripts" in dependencies || "react-scripts" in devDependencies) {
    config.extends = "react-cra";
  } else if ("electron-webpack" in devDependencies) {
    let filename = "electron-webpack/out/electron-builder.js";
    try {
      filename = require.resolve(filename, { paths: [projectDir] });
    } catch {
      filename = require.resolve("electron-webpack/electron-builder.yml", { paths: [projectDir] });
    }
    config.extends = `file:${filename}`;
  }
}

async function collectParentConfigs(config, request, configReader, result) {
  for (const spec of toArray(config.extends)) {
    if (typeof spec !== "string" || spec.trim() === "") {
      throw new Error("electron-builder config extends entries must be non-empty strings");
    }
    let parent;
    if (spec === "react-cra") {
      parent = await require("app-builder-lib/out/presets/rectCra").reactCra(request.projectDir);
    } else {
      const modulePath = resolveMjsParentPath(spec, request.projectDir);
      if (modulePath) parent = await loadMjsConfig(modulePath, request);
      else parent = (await configReader.loadParentConfig(request, spec)).result;
    }
    if (!isRecord(parent)) throw new Error(`electron-builder parent config must export an object: ${spec}`);
    parent = cloneConfig(parent);
    await collectParentConfigs(parent, request, configReader, result);
    result.push(parent);
  }
}

function resolveMjsParentPath(spec, projectDir) {
  const unprefixed = spec.startsWith("file:") ? spec.slice("file:".length) : spec;
  const candidate = path.resolve(projectDir, unprefixed);
  if (path.extname(candidate).toLowerCase() === ".mjs") return candidate;
  try {
    const resolved = require.resolve(spec, { paths: [projectDir] });
    if (path.extname(resolved).toLowerCase() === ".mjs") return resolved;
  } catch {
    // The normal read-config-file loader will report unresolved non-ESM specs.
  }
  return null;
}

function applyDefaultTargets(config) {
  const result = cloneConfig(config);
  for (const [key, targets] of Object.entries(DEFAULT_TARGETS)) {
    if (!isRecord(result[key])) result[key] = {};
    if (result[key].target === undefined) result[key].target = [...targets];
  }
  return result;
}

function resolveMinitronOptions(value, env, projectDir) {
  if (value !== undefined && !isRecord(value)) {
    throw new Error("package.json minitron must be an object when provided");
  }
  const result = { ...(value || {}) };
  for (const [variable, option] of [
    ["MINITRON_LAUNCHER", "launcherPath"],
    ["MINITRON_MANIFEST_URL", "manifestUrl"],
    ["MINITRON_PUBLIC_KEY", "manifestPublicKey"],
    ["MINITRON_LAUNCHER_VERSION", "launcherVersion"],
  ]) {
    if (env[variable] !== undefined) result[option] = env[variable];
  }
  result.projectDir = projectDir;
  return result;
}

function validateBuildTargets(targets, config, platformApi) {
  if (!(targets instanceof Map)) throw new Error("electron-builder did not normalize target selection");
  for (const [platform, archTargets] of targets) {
    const key = platform && platform.buildConfigurationKey;
    const supported = SUPPORTED_TARGETS[key];
    if (!supported) {
      throw new Error(`Minitron CLI does not support electron-builder platform ${String(key || platform)}`);
    }
    const configured = getConfiguredTargets(config[key] && config[key].target);
    for (const [arch, selectedTargets] of archTargets) {
      const names = selectedTargets && selectedTargets.length > 0
        ? selectedTargets
        : configured.length > 0
          ? configured
          : DEFAULT_TARGETS[key];
      for (const name of names) {
        const normalized = typeof name === "string" ? name.toLowerCase() : String(name);
        if (!supported.has(normalized)) {
          const allowed = [...supported].filter((target) => target !== "dir").join(", ");
          throw new Error(`Minitron CLI does not support ${key} target "${normalized}" for ${String(arch)}; supported installer targets: ${allowed}, or dir`);
        }
      }
    }
  }
  if (platformApi && !platformApi.MAC) throw new Error("electron-builder did not expose platform definitions");
}

function getConfiguredTargets(value) {
  if (value == null) return [];
  const result = [];
  const visit = (entry) => {
    if (typeof entry === "string") result.push(entry);
    else if (Array.isArray(entry)) entry.forEach(visit);
    else if (isRecord(entry) && typeof entry.target === "string") result.push(entry.target);
  };
  visit(value);
  return result;
}

async function createTemporaryConfig(config) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minitron-builder-"));
  const token = randomUUID();
  const effectiveConfig = cloneConfig(config);
  // The config has already had its `extends` chain resolved. Explicit null also
  // prevents electron-builder from applying an implicit preset a second time.
  effectiveConfig.extends = null;
  TEMPORARY_CONFIGS.set(token, effectiveConfig);
  const filename = path.join(directory, "electron-builder.cjs");
  const source = [
    '"use strict";',
    `module.exports = () => require(${JSON.stringify(__filename)}).getTemporaryConfig(${JSON.stringify(token)});`,
    "",
  ].join("\n");
  try {
    await fs.writeFile(filename, source, { flag: "wx" });
  } catch (error) {
    TEMPORARY_CONFIGS.delete(token);
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path: filename,
    async cleanup() {
      TEMPORARY_CONFIGS.delete(token);
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

function getTemporaryConfig(token) {
  const config = TEMPORARY_CONFIGS.get(token);
  if (!config) throw new Error("Temporary minitron-builder config expired before electron-builder loaded it");
  return config;
}

function toArray(value) {
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}

function cloneConfig(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (const item of value) result.push(cloneConfig(item, seen));
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const result = Object.create(prototype);
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) result[key] = cloneConfig(item, seen);
  return result;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  applyDefaultTargets,
  createTemporaryConfig,
  getTemporaryConfig,
  loadMjsConfig,
  normalizeBuilderConfigOption,
  readProjectPackage,
  resolveBuilderConfiguration,
  resolveMinitronOptions,
  runCli,
  validateBuildTargets,
};
