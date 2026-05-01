
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Manually read .env
const envPath = path.join(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const match = line.match(/^\s*([\w\.\-]+)\s*=\s*(.*)?\s*$/);
  if (match) {
    const key = match[1];
    let value = match[2] || '';
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    env[key] = value;
  }
});

const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function testPushSubscription() {
  console.log('Testing rpc_upsert_push_subscription...');

  // 1. Get a sample member and tenant
  const { data: members, error: mError } = await supabase
    .from('members')
    .select('id, tenant_id')
    .limit(1);

  if (mError || !members || members.length === 0) {
    console.error('Failed to get sample member:', mError);
    return;
  }

  const member = members[0];
  console.log(`Using member_id: ${member.id}, tenant_id: ${member.tenant_id}`);

  const testParams = {
    p_endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint-' + Date.now(),
    p_p256dh: 'test-p256dh',
    p_auth: 'test-auth',
    p_user_agent: 'test-agent',
    p_member_id: member.id,
    p_tenant_id: member.tenant_id
  };

  const { data, error } = await supabase.rpc('rpc_upsert_push_subscription', testParams);

  if (error) {
    console.error('RPC Error:', error);
  } else {
    console.log('RPC Success!', data);

    // Verify in DB
    const { data: rows, error: vError } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('endpoint', testParams.p_endpoint);

    if (vError) {
      console.error('Verification Error:', vError);
    } else {
      console.log('Verified rows:', rows);
    }
  }
}

testPushSubscription();
