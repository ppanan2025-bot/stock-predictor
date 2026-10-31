-- Seed companies (mirrors config/companies.json; test/schema.test.mjs keeps them in sync). Idempotent.
-- SPCX (Space Exploration Technologies Corp.) listed 2026-06-12: no data before 2026-06.
INSERT INTO companies (ticker, name, exchange, sector, industry, cik, ir_domains, peers, role, listed_on, active) VALUES
 ('GOOGL', 'Alphabet Inc. Class A', 'NASDAQ', 'Communication Services', 'Interactive Media & Services', '0001652044',
   JSON_ARRAY('abc.xyz','blog.google'), JSON_ARRAY('AMZN','AAPL'), 'target', '2004-08-19', 1),
 ('AMZN', 'Amazon.com, Inc.', 'NASDAQ', 'Consumer Discretionary', 'Broadline Retail', '0001018724',
   JSON_ARRAY('aboutamazon.com','ir.aboutamazon.com'), JSON_ARRAY('GOOGL','AAPL'), 'target', '1997-05-15', 1),
 ('AAPL', 'Apple Inc.', 'NASDAQ', 'Information Technology', 'Technology Hardware, Storage & Peripherals', '0000320193',
   JSON_ARRAY('apple.com','investor.apple.com'), JSON_ARRAY('GOOGL','AMZN'), 'target', '1980-12-12', 1),
 ('SPCX', 'Space Exploration Technologies Corp.', 'NASDAQ', 'Industrials', 'Aerospace & Defense', NULL,
   JSON_ARRAY(), JSON_ARRAY(), 'target', '2026-06-12', 1)
AS new
ON DUPLICATE KEY UPDATE name = new.name, exchange = new.exchange, sector = new.sector, industry = new.industry, cik = new.cik,
  ir_domains = new.ir_domains, peers = new.peers, role = new.role, listed_on = new.listed_on, active = new.active;
