import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeDelimitedField, parsePlaylistExportFormatSelection, playlistExportContent
} from '../src/playlist-export.js';

const playlist = {
  id: '88', name: '测试歌单', creator: { nickname: '创建者' }
};
const tracks = [
  { id: '1', name: '普通歌', artists: ['甲', '乙'], album: '专辑一' },
  { id: '2', name: '逗号,引号"和\r\n换行', artists: ['歌手\t二'], album: '专辑,二' }
];

test('解析歌单导出格式及格式选项中的输出目标', () => {
  assert.deepEqual(parsePlaylistExportFormatSelection('1'), {
    quit: false, format: 'songs', output: null
  });
  assert.deepEqual(parsePlaylistExportFormatSelection('3 > out.csv'), {
    quit: false, format: 'csv', output: 'out.csv'
  });
  assert.deepEqual(parsePlaylistExportFormatSelection('4 | "out.tsv"'), {
    quit: false, format: 'tsv', output: '"out.tsv"'
  });
  assert.deepEqual(parsePlaylistExportFormatSelection('3 >'), {
    quit: false, format: 'csv', output: null
  });
  assert.deepEqual(parsePlaylistExportFormatSelection('4 |'), {
    quit: false, format: 'tsv', output: null
  });
  assert.deepEqual(parsePlaylistExportFormatSelection('q'), { quit: true });
  assert.equal(parsePlaylistExportFormatSelection('5'), null);
});

test('仅歌曲格式每行只包含歌曲名', () => {
  assert.equal(playlistExportContent(playlist, tracks, 'songs'),
    '普通歌\n逗号,引号"和 换行');
});

test('详细文本格式保留歌单头和原有歌曲详情', () => {
  const content = playlistExportContent(playlist, tracks, 'text');
  assert.match(content, /^歌单：测试歌单\n创建者：创建者\nID：88\n链接：https:\/\/music\.163\.com\/#\/playlist\?id=88\n\n/);
  assert.match(content, /1\. 普通歌\t甲\/乙\t专辑一\tID:1/);
});

test('CSV 正确转义逗号、引号和 CRLF', () => {
  assert.equal(escapeDelimitedField('a,"b"\r\nc', ','), '"a,""b""\r\nc"');
  const content = playlistExportContent(playlist, tracks, 'csv');
  assert.equal(content.split('\n')[0], '序号,歌曲,歌手,专辑,ID');
  assert.match(content, /2,"逗号,引号""和\r\n换行",歌手\t二,"专辑,二",2$/);
});

test('TSV 正确转义制表符、引号和 CRLF', () => {
  const content = playlistExportContent(playlist, tracks, 'tsv');
  assert.equal(content.split('\n')[0], '序号\t歌曲\t歌手\t专辑\tID');
  assert.match(content, /2\t"逗号,引号""和\r\n换行"\t"歌手\t二"\t专辑,二\t2$/);
});
