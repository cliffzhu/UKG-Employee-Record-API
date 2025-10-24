# UKG Employee Lookup Cloudflare Worker

This Cloudflare Worker provides a secure API to look up UKG employee information by email address. **This worker is designed to be called only from other workers using API key authentication.**

## Setup

### 1. Install Wrangler CLI
```bash
npm install -g wrangler
```

### 2. Login to Cloudflare
```bash
wrangler login
```

### 3. Set Environment Secrets
Set the required secrets using Wrangler:

```bash
wrangler secret put UKG_CUSTOMER_API_KEY
# Enter: YOUR_CUSTOMER_API_KEY

wrangler secret put UKG_USER_API_KEY  
# Enter: YOUR_USER_API_KEY

wrangler secret put UKG_USERNAME
# Enter: your_username

wrangler secret put UKG_PASSWORD
# Enter: your_password_here

wrangler secret put WORKER_API_KEY
# Enter: your_secure_api_key_here (generate a strong random key)
```

### 4. Deploy the Worker
```bash
wrangler deploy
```

## Usage (Worker-to-Worker Only)

### From Another Cloudflare Worker

```javascript
// In your calling worker
const response = await fetch('https://ukg-employee-lookup.youraccount.workers.dev', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': env.UKG_LOOKUP_API_KEY, // Set this secret in your worker
  },
  body: JSON.stringify({
    email: 'firstname.lastname@yourdomain.com'
  })
});

const result = await response.json();
```

### Using curl (for testing)
```bash
curl -X POST https://ukg-employee-lookup.youraccount.workers.dev \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -d '{"email": "firstname.lastname@yourdomain.com"}'
```

## Security Features

🔒 **API Key Authentication**: Only requests with valid API key are processed
🚫 **No CORS**: Blocks browser-based requests  
🔐 **Encrypted Secrets**: All credentials stored securely in Cloudflare
⚡ **Worker-to-Worker**: Optimized for internal service communication

## Response Format

### Success Response
```json
{
  "success": true,
  "employeeNumber": "100624",
  "companyCode": "BPML",
  "firstName": "John",
  "lastName": "Doe",
  "email": "firstname.lastname@yourdomain.com"
}
```

### Error Response
```json
{
  "success": false,
  "error": "User not found",
  "email": "firstname.lastname@yourdomain.com"
}
```

### Not Found Response
```json
{
  "success": false,
  "error": "User not found",
  "email": "nonexistent@yourdomain.com"
}
```

## Environment Variables

### Required Secrets (set with `wrangler secret put`)
- `UKG_CUSTOMER_API_KEY`: Customer API key for UKG
- `UKG_USER_API_KEY`: User API key for UKG  
- `UKG_USERNAME`: Username for UKG authentication
- `UKG_PASSWORD`: Password for UKG authentication

### Required Variables (set in `wrangler.toml`)
- `UKG_BASE_URL`: Base URL for UKG services (default: "https://service.ultipro.ca")

## Local Development

To test locally:

```bash
wrangler dev
```

Then make requests to `http://localhost:8787`

## Security Notes

- All sensitive credentials are stored as encrypted secrets in Cloudflare
- The worker supports CORS for browser-based requests
- No credentials are exposed in the code or logs

## API Features

- **Email Lookup**: Find employee last (most recent) record by email address
- **CORS Support**: Can be called from web browsers
- **Error Handling**: Comprehensive error responses
- **Fast**: Serverless execution with global edge deployment
- **Secure**: Credentials stored as encrypted secrets
