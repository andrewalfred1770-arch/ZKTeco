/**
 * seed-company-settings.js — default rows for the runtime-editable
 * "بيانات الشركة" branding store (CompanySetting key/value table).
 *
 * Idempotent: upsert by unique `key`, but only on CREATE — re-running never
 * overwrites a value the user has already edited.
 *
 *   node prisma/seed-company-settings.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// key, value, type
const DEFAULTS = [
  ['company_name_ar',      'PETSHROW',                                   'text'],
  ['company_name_en',      'PETSHROW',                                   'text'],
  ['company_description',  'إدارة الموارد البشرية والرواتب',              'longtext'],
  ['company_address',      'القاهرة، مصر',                               'text'],
  ['company_phone',        '02-12345678',                                'text'],
  ['company_email',        '',                                           'text'],
  ['logo_url',             '',                                           'image'],
  ['login_background_url', '',                                           'image'],
  ['stamp_url',            '',                                           'image'],
  ['print_header_url',     '',                                           'image'],
  ['print_header_text',    '',                                           'longtext'],
  ['print_footer_text',    '© PETSHROW ERP — جميع الحقوق محفوظة',         'longtext'],
  ['print_contact_text',   '',                                           'longtext'],
];

async function main() {
  for (const [key, value, type] of DEFAULTS) {
    await prisma.companySetting.upsert({
      where: { key },
      update: {},               // never touch an existing row — preserve user edits
      create: { key, value, type, updatedBy: 'seed' },
    });
  }
  console.log(`✓ Seeded ${DEFAULTS.length} company settings (existing rows untouched)`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
