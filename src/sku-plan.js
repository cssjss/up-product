const COLOR_FAMILIES = {
  白色系: ['乳白色', '白色', '米白色'],
  灰色系: ['浅灰色', '深灰色', '灰色', '银色'],
  黑色系: ['黑色'],
  红色系: ['桔红色', '玫红色', '粉红色', '红色', '藕色', '西瓜红', '酒红色'],
  黄色系: ['卡其色', '姜黄色', '明黄色', '杏色', '柠檬黄', '桔色', '浅黄色', '荧光黄', '金色', '香槟色', '黄色'],
  绿色系: ['军绿色', '墨绿色', '浅绿色', '绿色', '翠绿色', '荧光绿', '青色'],
  蓝色系: ['天蓝色', '孔雀蓝', '宝蓝色', '浅蓝色', '深蓝色', '湖蓝色', '蓝色', '藏青色'],
  紫色系: ['浅紫色', '深紫色', '紫红色', '紫罗兰', '紫色'],
  棕色系: ['咖啡色', '巧克力色', '栗色', '浅棕色', '深卡其布色', '深棕色', '褐色', '驼色'],
  花色系: ['花色'], 透明系: ['透明'], 其他: ['棕色', '混合多色'],
};

const COLOR_TO_FAMILY = new Map(Object.entries(COLOR_FAMILIES).flatMap(([family, colors]) => colors.map((color) => [color, family])));
const STANDARD_COLORS = new Set(COLOR_TO_FAMILY.keys());

const COLOR_BASE = new Map([
  ['亮粉色', '粉红色'], ['粉色', '粉红色'], ['树莓色', '紫红色'],
  ['梅子色', '紫色'], ['橙色', '桔色'], ['奶茶色', '咖啡色'],
  ['砖红色', '酒红色'],
]);

function expandModelName(source) {
  const clean = source.split('（')[0].trim().replace(/^苹果/i, '').toUpperCase();
  const parts = clean.split('/').map((part) => part.trim());
  const result = [];
  for (const part of parts) {
    if (part === 'XR') { result.push('iPhone XR'); continue; }
    const match = /^(\d{1,2})(PROMAX|PRO|PLUS|AIR)?$/.exec(part);
    if (!match) throw new Error(`无法拆分手机型号「${source}」中的「${part}」`);
    const [, number, suffix = ''] = match;
    if (suffix === 'AIR' && number === '17') { result.push('iPhone Air'); continue; }
    const tail = { PROMAX: ' Pro Max', PRO: ' Pro', PLUS: ' Plus', AIR: ' Air' }[suffix] ?? '';
    result.push(`iPhone ${number}${tail}`);
  }
  return result;
}

export function buildSkuPlan(skuRows) {
  const issues = [];
  const sourceColors = [...new Set(skuRows.map((row) => row.color))];
  const sourceModels = [...new Set(skuRows.map((row) => row.model))];
  const twoLayer = sourceColors.length > 1 && sourceModels.length > 1;
  const mode = twoLayer ? 'two-layer' : 'single-layer';
  const colorSpecs = sourceColors.map((color) => {
    const base = COLOR_BASE.get(color) ?? (STANDARD_COLORS.has(color) ? color : null);
    if (twoLayer && !base) issues.push(`颜色「${color}」缺少千牛标准主色映射`);
    return { color, base, family: COLOR_TO_FAMILY.get(base) ?? null, remark: base === color ? '' : color, image: skuRows.find((row) => row.color === color)?.skuImage ?? null };
  });
  const listingRows = [];
  const seen = new Map();
  for (const row of skuRows) {
    let models;
    try { models = twoLayer ? expandModelName(row.model) : [row.model]; }
    catch (error) { issues.push(error.message); continue; }
    for (const model of models) {
      const key = `${row.color}\u0000${model}`;
      const existing = seen.get(key);
      if (existing) {
        issues.push(`拆分后规格重复：${row.color} / ${model}（来源 SKU ${existing}、${row.sourceSkuId}）`);
        continue;
      }
      seen.set(key, row.sourceSkuId);
      listingRows.push({ ...row, model, sourceModel: row.model });
    }
  }
  const models = [...new Set(listingRows.map((row) => row.model))];
  if (twoLayer && listingRows.length !== sourceColors.length * models.length) {
    issues.push(`分层规格不是完整的颜色×型号组合：${listingRows.length}/${sourceColors.length * models.length}；当前千牛会自动生成额外组合`);
  }
  return {
    mode,
    singleProperty: sourceColors.length > 1 ? 'color' : 'model',
    sourceCount: skuRows.length,
    rows: listingRows,
    colors: colorSpecs,
    models,
    issues,
  };
}
