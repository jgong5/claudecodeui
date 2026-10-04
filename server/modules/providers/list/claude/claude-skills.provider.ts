import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type {
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderSkillSource,
} from '@/shared/types.js';
import {
  findProviderSkillMarkdownFiles,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readProviderSkillMarkdownDefinition,
  readProviderSkillMarkdownDefinitionFromContent,
} from '@/shared/utils.js';

const getClaudeHomePath = (): string => path.join(os.homedir(), '.claude');

const getClaudePluginName = (pluginId: string): string | null => {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId || normalizedPluginId === '@') {
    return null;
  }

  const [pluginName] = normalizedPluginId.split('@');
  return readOptionalString(pluginName) ?? null;
};

const stripMarkdownExtension = (filename: string): string =>
  filename.replace(/\.md$/i, '');

const pathExistsAsDirectory = async (directoryPath: string): Promise<boolean> => {
  try {
    const directoryStats = await stat(directoryPath);
    return directoryStats.isDirectory();
  } catch {
    return false;
  }
};

const pathExistsAsFile = async (filePath: string): Promise<boolean> => {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
};

const readClaudePluginManifest = async (installPath: string): Promise<Record<string, unknown>> => {
  try {
    return await readJsonConfig(path.join(installPath, '.claude-plugin', 'plugin.json'));
  } catch {
    // Older or partial plugin installs may not have a readable plugin.json.
    return {};
  }
};

/**
 * Finds the plugin's entry in the marketplace it was installed from, through
 * `known_marketplaces.json`. Plugins of one marketplace repo can share its
 * root, and the entry's `skills` list is what tells them apart.
 */
const readClaudeMarketplaceEntry = async (
  claudeHomePath: string,
  pluginId: string,
): Promise<Record<string, unknown> | null> => {
  const [entryName, marketplaceName] = pluginId.split('@');
  if (!entryName || !marketplaceName) {
    return null;
  }

  try {
    const knownMarketplaces = await readJsonConfig(
      path.join(claudeHomePath, 'plugins', 'known_marketplaces.json'),
    );
    const installLocation = readOptionalString(
      readObjectRecord(knownMarketplaces[marketplaceName])?.installLocation,
    );
    if (!installLocation) {
      return null;
    }

    const marketplace = await readJsonConfig(
      path.join(installLocation, '.claude-plugin', 'marketplace.json'),
    );
    const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    return entries.map(readObjectRecord).find((entry) => entry?.name === entryName) ?? null;
  } catch {
    return null;
  }
};

const readPathList = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim() !== '',
  );

/**
 * Lists the folders Claude Code scans for a plugin's skills: the default
 * `skills/`, plus the `skills` paths of plugin.json and the marketplace entry.
 * An entry sourced from the marketplace root that lists `skills` loads only
 * those, because the root's `skills/` also holds its sibling plugins' skills.
 */
const getClaudePluginSkillRoots = (
  manifest: Record<string, unknown>,
  entry: Record<string, unknown> | null,
): string[] => {
  const entrySkills = readPathList(entry?.skills);
  const source = typeof entry?.source === 'string' ? path.posix.normalize(entry.source) : null;
  const replacesDefault = source === '.' || source === './';
  return [
    ...(replacesDefault && entrySkills.length > 0 ? [] : ['./skills']),
    ...readPathList(manifest.skills),
    ...entrySkills,
  ];
};

export class ClaudeSkillsProvider extends SkillsProvider {
  constructor() {
    super('claude');
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    return [
      ...(await super.listSkills(options)),
      ...(await this.listPluginSkills(getClaudeHomePath())),
    ];
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const claudeHomePath = getClaudeHomePath();

    return [
      {
        scope: 'user',
        rootDir: path.join(claudeHomePath, 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.claude', 'skills'),
        commandPrefix: '/',
      },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(getClaudeHomePath(), 'skills'),
      commandPrefix: '/',
    };
  }

  private async listPluginSkills(claudeHomePath: string): Promise<ProviderSkill[]> {
    const settings = await readJsonConfig(path.join(claudeHomePath, 'settings.json'));
    const enabledPlugins = readObjectRecord(settings.enabledPlugins);
    if (!enabledPlugins) {
      return [];
    }

    const installedConfig = await readJsonConfig(
      path.join(claudeHomePath, 'plugins', 'installed_plugins.json'),
    );
    const installedPlugins = readObjectRecord(installedConfig.plugins);
    if (!installedPlugins) {
      return [];
    }

    const skills: ProviderSkill[] = [];
    const visitedPluginFolders = new Set<string>();
    const pluginEntries = Object.entries(enabledPlugins)
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [pluginId, enabled] of pluginEntries) {
      if (enabled !== true) {
        continue;
      }

      const installs = installedPlugins[pluginId];
      if (!Array.isArray(installs)) {
        continue;
      }

      for (const install of installs) {
        const installRecord = readObjectRecord(install);
        const installPath = readOptionalString(installRecord?.installPath);
        if (!installPath) {
          continue;
        }

        // Only the installed version is read: sibling version folders are
        // stale copies Claude Code no longer loads.
        const pluginFolderKey = `${pluginId}:${path.resolve(installPath)}`;
        if (visitedPluginFolders.has(pluginFolderKey)) {
          continue;
        }
        visitedPluginFolders.add(pluginFolderKey);

        const manifest = await readClaudePluginManifest(installPath);
        // Without a plugin.json name, the plugin id keeps discovery useful
        // without inventing a separate namespace.
        const pluginName = readOptionalString(manifest.name) ?? getClaudePluginName(pluginId);
        if (!pluginName) {
          continue;
        }

        // A plugin may ship commands, skills, or both, and the CLI offers
        // both halves. Reading only the first folder found hid every skill
        // that sits beside a commands folder -- and hid the whole plugin when
        // its commands are in a format this reader does not take.
        const commandsPath = path.join(installPath, 'commands');
        if (await pathExistsAsDirectory(commandsPath)) {
          skills.push(
            ...(await this.listPluginCommandSkills(commandsPath, pluginId, pluginName)),
          );
        }

        const skillRoots = getClaudePluginSkillRoots(
          manifest,
          await readClaudeMarketplaceEntry(claudeHomePath, pluginId),
        );
        skills.push(
          ...(await this.listPluginSkillMarkdowns(installPath, skillRoots, pluginId, pluginName)),
        );
      }
    }

    return skills;
  }

  private async listPluginCommandSkills(
    commandsPath: string,
    pluginId: string,
    pluginName: string,
  ): Promise<ProviderSkill[]> {
    const skills: ProviderSkill[] = [];

    try {
      const entries = await readdir(commandsPath, { withFileTypes: true });
      const commandFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .sort((left, right) => left.name.localeCompare(right.name));

      for (const commandFile of commandFiles) {
        const sourcePath = path.join(commandsPath, commandFile.name);
        try {
          const definition = await this.readPluginCommandDefinition(sourcePath);
          skills.push({
            provider: this.provider,
            name: definition.name,
            description: definition.description,
            command: `/${pluginName}:${definition.name}`,
            scope: 'plugin',
            sourcePath,
            pluginName,
            pluginId,
          });
        } catch {
          // Malformed command markdown should not block sibling plugin commands.
        }
      }
    } catch {
      // Missing or unreadable command folders are treated as empty plugin command sets.
    }

    return skills;
  }

  private async readPluginCommandDefinition(
    commandPath: string,
  ): Promise<{ name: string; description: string }> {
    const content = await readFile(commandPath, 'utf8');
    // A command is always named by its file; only the description is read.
    const name = stripMarkdownExtension(path.basename(commandPath));
    const { description } = readProviderSkillMarkdownDefinitionFromContent(content, name);

    return { name, description };
  }

  private async listPluginSkillMarkdowns(
    installPath: string,
    skillRoots: string[],
    pluginId: string,
    pluginName: string,
  ): Promise<ProviderSkill[]> {
    const pluginRoot = path.resolve(installPath);
    const skillFiles = new Set<string>();
    for (const skillRoot of skillRoots) {
      const rootPath = path.resolve(pluginRoot, skillRoot);
      // Claude Code does not load a path that escapes the plugin root.
      if (rootPath !== pluginRoot && !rootPath.startsWith(`${pluginRoot}${path.sep}`)) {
        continue;
      }

      // A listed path is either one skill folder or a folder of skill folders.
      const directSkillPath = path.join(rootPath, 'SKILL.md');
      const rootSkillFiles = (await pathExistsAsFile(directSkillPath))
        ? [directSkillPath]
        : await findProviderSkillMarkdownFiles(rootPath);
      rootSkillFiles.forEach((skillFile) => skillFiles.add(skillFile));
    }
    const skills: ProviderSkill[] = [];

    for (const skillPath of skillFiles) {
      try {
        const definition = await readProviderSkillMarkdownDefinition(skillPath);
        skills.push({
          provider: this.provider,
          name: definition.name,
          description: definition.description,
          command: `/${pluginName}:${definition.name}`,
          scope: 'plugin',
          sourcePath: skillPath,
          pluginName,
          pluginId,
        });
      } catch {
        // A bad plugin skill file should not block other installed plugin skills.
      }
    }

    return skills;
  }
}
