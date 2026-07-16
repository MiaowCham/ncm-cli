const FORMAT_BY_CHOICE = Object.freeze({
  1: 'songs',
  2: 'text',
  3: 'csv',
  4: 'tsv'
});

function creatorName(playlist) {
  return playlist.creatorName || playlist.creator?.nickname || playlist.creator?.name || '未知';
}

function playlistLink(id) {
  return `https://music.163.com/#/playlist?id=${id}`;
}

function songRow(song, index) {
  return [
    index + 1,
    song.name || '',
    song.artists?.join('/') || '未知歌手',
    song.album || '未知专辑',
    song.id ?? ''
  ];
}

export function escapeDelimitedField(value, delimiter) {
  const text = String(value ?? '');
  if (!text.includes(delimiter) && !/["\r\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function delimitedExport(tracks, delimiter) {
  const rows = [
    ['序号', '歌曲', '歌手', '专辑', 'ID'],
    ...tracks.map(songRow)
  ];
  return rows
    .map((row) => row.map((field) => escapeDelimitedField(field, delimiter)).join(delimiter))
    .join('\n');
}

export function playlistExportContent(playlist, tracks, format) {
  if (format === 'songs') {
    return tracks.map((song) => String(song.name || '').replace(/[\r\n]+/g, ' ')).join('\n');
  }
  if (format === 'csv') return delimitedExport(tracks, ',');
  if (format === 'tsv') return delimitedExport(tracks, '\t');
  if (format !== 'text') throw new Error(`未知歌单导出格式：${format}`);

  const header = [
    `歌单：${playlist.name}`,
    `创建者：${creatorName(playlist)}`,
    `ID：${playlist.id}`,
    `链接：${playlistLink(playlist.id)}`,
    ''
  ];
  const rows = tracks.map((song, index) => [
    `${index + 1}. ${song.name}`,
    song.artists?.join('/') || '未知歌手',
    song.album || '未知专辑',
    `ID:${song.id}`
  ].join('\t'));
  return [...header, ...rows].join('\n');
}

export function parsePlaylistExportFormatSelection(raw) {
  const value = String(raw ?? '').trim();
  if (/^(?:q|quit|返回)$/i.test(value)) return { quit: true };
  const match = value.match(/^([1-4])(?:\s*(?:>|\|)\s*(.*))?$/);
  if (!match) return null;
  return {
    quit: false,
    format: FORMAT_BY_CHOICE[match[1]],
    output: match[2]?.trim() || null
  };
}
