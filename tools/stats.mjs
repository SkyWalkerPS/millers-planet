export function percentile(values, quantile) {
  if (!values || !values.length) return NaN;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

export const median = (values) => percentile(values, 0.5);

export function summarise(values) {
  const finiteValues = (values || []).filter((value) => Number.isFinite(value));
  if (!finiteValues.length) return { count: 0, min: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN };
  let minimum = Infinity;
  let maximum = -Infinity;
  let total = 0;
  for (const value of finiteValues) {
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
    total += value;
  }
  return {
    count: finiteValues.length,
    min: minimum,
    p50: percentile(finiteValues, 0.5),
    p95: percentile(finiteValues, 0.95),
    p99: percentile(finiteValues, 0.99),
    max: maximum,
    mean: total / finiteValues.length,
  };
}

export function formatNumber(value, digits = 2) {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
  return value.toFixed(digits);
}

export function formatTable(headerCells, rows, { rightAlignFrom = 1 } = {}) {
  const allRows = [headerCells, ...rows].map((row) => row.map((cell) => (cell === undefined || cell === null ? '' : String(cell))));
  const columnWidths = headerCells.map((_, columnIndex) => Math.max(...allRows.map((row) => (row[columnIndex] ?? '').length)));
  const renderRow = (row) => row.map((cell, columnIndex) => (columnIndex >= rightAlignFrom ? cell.padStart(columnWidths[columnIndex]) : cell.padEnd(columnWidths[columnIndex]))).join('  ').trimEnd();
  const separator = columnWidths.map((width) => '-'.repeat(width)).join('  ');
  return [renderRow(allRows[0]), separator, ...allRows.slice(1).map(renderRow)].join('\n');
}
