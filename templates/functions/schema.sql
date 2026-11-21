-- 匿名统计表（D1，可选模块，见 docs/ANALYTICS.md）。只存随机匿名 ID、事件名、日序号、服务器时间、版本号；不存 IP、设备、页面地址。语句须可重复执行（IF NOT EXISTS），pages.sh 每次发布按分号拆开逐条执行，注释里不要写半角分号。
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  aid TEXT NOT NULL,
  ev TEXT NOT NULL,
  day INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  v TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_day ON events (day);
CREATE INDEX IF NOT EXISTS events_aid ON events (aid, day);
