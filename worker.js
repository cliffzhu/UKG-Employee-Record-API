/**
 * Cloudflare Worker to get UKG employee information by email
 * 
 * Required Environment Variables:
 * - UKG_CUSTOMER_API_KEY: Customer API key (e.g., "YOUR_CUSTOMER_API_KEY")
 * - UKG_USER_API_KEY: User API key (e.g., "YOUR_USER_API_KEY")
 * - UKG_USERNAME: Username for authentication
 * - UKG_PASSWORD: Password for authentication
 * - UKG_BASE_URL: Base URL for UKG services (e.g., "https://service.ultipro.ca")
 * - WORKER_API_KEY: Secret key for worker-to-worker authentication
 */

export default {
  async fetch(request, env, ctx) {
    try {
      // Check for API key authentication
      const apiKey = request.headers.get('X-API-Key') || request.headers.get('Authorization')?.replace('Bearer ', '');
      
      if (!apiKey || apiKey !== env.WORKER_API_KEY) {
        return new Response(JSON.stringify({
          error: 'Unauthorized - Invalid or missing API key',
          code: 'INVALID_API_KEY'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Parse request for email parameter
      let emailToSearch;
        if (request.method === 'GET') {
        const url = new URL(request.url);
        emailToSearch = url.searchParams.get('email');
      } else if (request.method === 'POST') {
        const body = await request.json();
        emailToSearch = body.email;
      }

      if (!emailToSearch) {
        return new Response(JSON.stringify({
          error: 'Email parameter is required',
          usage: 'GET: ?email=user@domain.com or POST: {"email": "user@domain.com"}',
          headers_required: 'X-API-Key: your_api_key'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Validate environment variables
      const requiredVars = ['UKG_CUSTOMER_API_KEY', 'UKG_USER_API_KEY', 'UKG_USERNAME', 'UKG_PASSWORD', 'UKG_BASE_URL', 'WORKER_API_KEY'];
      for (const varName of requiredVars) {
        if (!env[varName]) {
          return new Response(JSON.stringify({
            error: `Missing environment variable: ${varName}`
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Step 1: Authenticate and get token
      const token = await authenticateUKG(env);
      if (!token) {
        return new Response(JSON.stringify({
          error: 'Failed to authenticate with UKG API'
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Step 2: Search for user by email
      console.log(`Searching for user with email: ${emailToSearch}`);
      const userInfo = await findUserByEmail(env, token, emailToSearch);
      
      if (userInfo) {
        console.log(`User found: ${JSON.stringify(userInfo)}`);
        return new Response(JSON.stringify({
          success: true,
          employeeNumber: userInfo.employeeNumber,
          companyCode: userInfo.companyCode,
          firstName: userInfo.firstName,
          lastName: userInfo.lastName,
          email: emailToSearch
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        console.warn(`User not found for email: ${emailToSearch}`);
        return new Response(JSON.stringify({
          success: false,
          error: 'User not found',
          email: emailToSearch
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

    } catch (error) {
      console.error('Error occurred:', error);
      return new Response(JSON.stringify({
        error: 'Internal server error',
        details: error.message
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

/**
 * Authenticate with UKG API and return authentication token
 */
async function authenticateUKG(env) {
  const loginServiceUrl = `${env.UKG_BASE_URL}/services/LoginService`;
  
  const loginEnvelope = `
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://www.w3.org/2005/08/addressing"
            xmlns:login="http://www.ultipro.com/services/loginservice"
            xmlns:contracts="http://www.ultipro.com/contracts">
  <s:Header>
    <a:Action s:mustUnderstand="1">http://www.ultipro.com/services/loginservice/ILoginService/Authenticate</a:Action>
    <a:To s:mustUnderstand="1">${loginServiceUrl}</a:To>
    <login:ClientAccessKey>${env.UKG_CUSTOMER_API_KEY}</login:ClientAccessKey>
    <login:Password>${env.UKG_PASSWORD}</login:Password>
    <login:UserAccessKey>${env.UKG_USER_API_KEY}</login:UserAccessKey>
    <login:UserName>${env.UKG_USERNAME}</login:UserName>
  </s:Header>
  <s:Body>
    <contracts:TokenRequest>
    </contracts:TokenRequest>
  </s:Body>
</s:Envelope>`;

  try {
    const response = await fetch(loginServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
      },
      body: loginEnvelope,
    });

    if (!response.ok) {
      console.error('Login failed:', response.status, response.statusText);
      return null;
    }

    const responseText = await response.text();
    
    // Parse XML to extract token
    const tokenMatch = responseText.match(/<Token[^>]*>([^<]+)<\/Token>/);
    if (tokenMatch && tokenMatch[1]) {
      return tokenMatch[1];
    }
    
    console.error('Token not found in response');
    return null;
  } catch (error) {
    console.error('Authentication error:', error);
    return null;
  }
}

/**
 * Find user by email using SSO User service
 */
async function findUserByEmail(env, token, emailToSearch) {
  const ssoUserServiceUrl = `${env.UKG_BASE_URL}/services/EmployeeSsoUser`;
  
  const ssoUserEnvelope = `
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://www.w3.org/2005/08/addressing"
            xmlns:sso="http://www.ultipro.com/services/employeessouser"
            xmlns:con="http://www.ultipro.com/contracts">
  <s:Header>
    <a:Action s:mustUnderstand="1">http://www.ultipro.com/services/employeessouser/IEmployeeSsoUser/FindSsoUsers</a:Action>
    <a:To s:mustUnderstand="1">${ssoUserServiceUrl}</a:To>
    <UltiProToken xmlns="http://www.ultimatesoftware.com/foundation/authentication/ultiprotoken">${token}</UltiProToken>
    <ClientAccessKey xmlns="http://www.ultimatesoftware.com/foundation/authentication/clientaccesskey">${env.UKG_CUSTOMER_API_KEY}</ClientAccessKey>
  </s:Header>
  <s:Body>
    <sso:FindSsoUsers>
      <sso:query>
      </sso:query>
    </sso:FindSsoUsers>
  </s:Body>
</s:Envelope>`;

  try {
    const response = await fetch(ssoUserServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
      },
      body: ssoUserEnvelope,
    });

    if (!response.ok) {
      console.error('SSO User query failed:', response.status, response.statusText);
      return null;
    }

    const responseText = await response.text();
    
    // Parse XML to find user with matching email
    return parseUserFromXML(responseText, emailToSearch);
  } catch (error) {
    console.error('SSO User query error:', error);
    return null;
  }
}

/**
 * Parse XML response to find user with matching email (returns last match if multiple found)
 */
function parseUserFromXML(xmlText, emailToSearch) {
  try {
    let lastMatchedUser = null;
    let matchCount = 0;
    
    // Find all EmployeeSsoUser blocks
    const employeePattern = /<b:EmployeeSsoUser>(.*?)<\/b:EmployeeSsoUser>/gs;
    let match;
    
    while ((match = employeePattern.exec(xmlText)) !== null) {
      const employeeBlock = match[1];
      
      // Extract basic employee info
      const companyCodeMatch = employeeBlock.match(/<b:CompanyCode>([^<]+)<\/b:CompanyCode>/);
      const employeeNumberMatch = employeeBlock.match(/<b:EmployeeNumber>([^<]+)<\/b:EmployeeNumber>/);
      const firstNameMatch = employeeBlock.match(/<b:FirstName>([^<]+)<\/b:FirstName>/);
      const lastNameMatch = employeeBlock.match(/<b:LastName>([^<]+)<\/b:LastName>/);
      
      // Check SSO users within this employee
      const ssoUserPattern = /<b:SsoUser>(.*?)<\/b:SsoUser>/gs;
      let ssoMatch;
      
      while ((ssoMatch = ssoUserPattern.exec(employeeBlock)) !== null) {
        const ssoUserBlock = ssoMatch[1];
        
        // Extract email addresses
        const clientUserNameMatch = ssoUserBlock.match(/<b:ClientUserName>([^<]+)<\/b:ClientUserName>/);
        const ultiProUserNameMatch = ssoUserBlock.match(/<b:UltiProUserName>([^<]+)<\/b:UltiProUserName>/);
        
        // Check if this SSO user matches the email we're looking for (case-insensitive)
        const clientUserName = clientUserNameMatch ? clientUserNameMatch[1] : '';
        const ultiProUserName = ultiProUserNameMatch ? ultiProUserNameMatch[1] : '';
        
        if (clientUserName.toLowerCase() === emailToSearch.toLowerCase() || ultiProUserName.toLowerCase() === emailToSearch.toLowerCase()) {
          matchCount++;
          // Store this match as the last found match (overwrites previous matches)
          lastMatchedUser = {
            employeeNumber: employeeNumberMatch ? employeeNumberMatch[1] : '',
            companyCode: companyCodeMatch ? companyCodeMatch[1] : '',
            firstName: firstNameMatch ? firstNameMatch[1] : '',
            lastName: lastNameMatch ? lastNameMatch[1] : '',
          };
          console.log(`Found match #${matchCount} for ${emailToSearch}: Employee ${lastMatchedUser.employeeNumber}`);
        }
      }
    }
    
    if (matchCount > 1) {
      console.log(`Multiple records found (${matchCount}) for ${emailToSearch}, returning last match: Employee ${lastMatchedUser.employeeNumber}`);
    }
    
    return lastMatchedUser; // Returns the last matched user, or null if none found
  } catch (error) {
    console.error('XML parsing error:', error);
    return null;
  }
}
