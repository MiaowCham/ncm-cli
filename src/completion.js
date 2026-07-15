import { QUALITY_LEVELS } from './parsers.js';

export const SLASH_COMMANDS = Object.freeze([
  '/id',
  '/idlyric',
  '/lyric',
  '/lspl',
  '/pl',
  '/login',
  '/signout',
  '/quality',
  '/offset',
  '/smtcoffset',
  '/api',
  '/clear',
  '/help',
  '/quit'
]);

export const COMMAND_DESCRIPTIONS = Object.freeze({
  '/id': '按歌曲 ID 点歌',
  '/idlyric': '按歌曲 ID 获取歌词',
  '/lyric': '搜索并获取歌词',
  '/lspl': '列出用户歌单',
  '/pl': '预览歌单',
  '/login': '登录或查看登录状态',
  '/signout': '退出登录',
  '/quality': '查看或设置音质',
  '/offset': '查看或设置播放偏移',
  '/smtcoffset': '查看或设置 SMTC 额外偏移',
  '/api': '查看或更换 API 地址',
  '/clear': '清屏',
  '/help': '显示帮助',
  '/quit': '退出程序'
});

const LYRIC_FORMATS = Object.freeze(['plain', 'lrc', 'trans', 'all']);

function completeValues(line, prefix, value, values) {
  const normalized = value.toLowerCase();
  const matches = values
    .filter((candidate) => candidate.startsWith(normalized))
    .map((candidate) => `${prefix}${candidate}`);
  return [matches, line];
}

function completeLyricFormat(line, command, separator, argument) {
  // 格式位于查询词/歌曲 ID 后，因此至少需要一个非空的前置参数。
  const match = argument.match(/^(.*\S)(\s+)(\S*)$/);
  if (!match) return [[], line];
  return completeValues(
    line,
    `${command}${separator}${match[1]}${match[2]}`,
    match[3],
    LYRIC_FORMATS
  );
}

/**
 * Node readline completer。候选使用整行文本，避免补全参数时丢失已输入的命令和查询词。
 */
export function commandCompleter(input) {
  const line = String(input ?? '');
  const commandOnly = line.match(/^(\s*)(\/\S*)$/);

  if (commandOnly) {
    const [, leading, value] = commandOnly;
    const normalized = value.toLowerCase();
    const matches = SLASH_COMMANDS
      .filter((command) => command.startsWith(normalized))
      .map((command) => `${leading}${command}`);
    return [matches, line];
  }

  const withArgument = line.match(/^(\s*)(\/\S+)(\s+)([\s\S]*)$/);
  if (!withArgument) return [[], line];

  const [, leading, typedCommand, separator, argument] = withArgument;
  const command = typedCommand.toLowerCase();
  const prefix = `${leading}${typedCommand}${separator}`;

  if (command === '/quality') {
    return completeValues(line, prefix, argument, QUALITY_LEVELS);
  }
  if (command === '/login') {
    return completeValues(line, prefix, argument, ['status']);
  }
  if (command === '/idlyric' || command === '/lyric') {
    return completeLyricFormat(line, `${leading}${typedCommand}`, separator, argument);
  }

  return [[], line];
}

