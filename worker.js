/**
 * Cloudflare Worker to get UKG employee information by email
 * 
 * Required Environment Variables:
 * - UKG_CUSTOMER_API_KEY: Customer API key (e.g., "YOUR_CUSTOMER_API_KEY")
 * - UKG_USER_API_KEY: User API key (e.g., "YOUR_USER_API_KEY")
 * - UKG_USERNAME: Username for authentication
 * - UKG_PASSWORD: Password for authentication
 * - UKG_BASE_URL: Base URL for UKG services (e.g., "https://service3.ultipro.ca")
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

      // Parse request for email parameter and debug flag
      let emailToSearch;
      let debugMode = false;
      if (request.method === 'GET') {
        const url = new URL(request.url);
        emailToSearch = url.searchParams.get('email');
        debugMode = url.searchParams.get('debug') === 'true';
      } else if (request.method === 'POST') {
        const body = await request.json();
        emailToSearch = body.email;
        debugMode = body.debug === true;
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
      console.log(`Searching for user with email: ${emailToSearch}${debugMode ? ' (DEBUG MODE)' : ''}`);
      let userInfo = await findUserByEmail(env, token, emailToSearch, debugMode);
      
      // Step 3: Process SSO user info (could be single record or array)
      if (userInfo) {
        // Handle both single records and arrays of records
        const userRecords = Array.isArray(userInfo) ? userInfo : [userInfo];
        console.log(`Processing ${userRecords.length} SSO record(s) for ${emailToSearch}`);
        
        // Process each record to get additional details
        for (let i = 0; i < userRecords.length; i++) {
          const record = userRecords[i];
          console.log(`\n--- Processing Record ${i + 1}/${userRecords.length} ---`);
          console.log(`Employee ${record.employeeNumber}, Company ${record.companyCode}`);
          console.log(`Available identifiers: EmployeeNumber=${record.employeeNumber}, ClientUserName=${record.clientUserName}, UltiProUserName=${record.ultiProUserName}`);
          
          // Check employment status via EmployeeEmploymentInformation service
          console.log(`Checking employment status via EmployeeEmploymentInformation service...`);
          let employmentResult = null;
          try {
            employmentResult = await getEmploymentInformationByEmployeeIdentifier(env, token, record.companyCode, record.employeeNumber, debugMode);
            if (employmentResult) {
              record.employmentDetails = employmentResult;
              console.log(`Employment details found for Record ${i + 1}: ${employmentResult.employmentStatus}`);
            }
          } catch (error) {
            console.log(`Employment info check failed: ${error.message}`);
          }
        }
        
        // Filter records to only keep those with Employment Status = 'A' (Active)
        const activeRecords = userRecords.filter(record => 
          record.employmentDetails && 
          record.employmentDetails.employmentStatus === 'A'
        );
        
        console.log(`Found ${activeRecords.length} active record(s) out of ${userRecords.length} total records`);
        
        // Choose the primary record - use the LAST active record
        let primaryRecord;
        if (activeRecords.length > 0) {
          primaryRecord = activeRecords[activeRecords.length - 1]; // Take the LAST active record
          console.log(`Selected LAST active record from company ${primaryRecord.companyCode} as primary record`);
        } else {
          // No active records found - this means all records are terminated
          console.log(`No active records found among ${userRecords.length} total records for ${emailToSearch}`);
          return new Response(JSON.stringify({
            success: false,
            error: 'No active employee records found',
            totalRecords: userRecords.length,
            email: emailToSearch,
            details: 'All employee records found are terminated or inactive'
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        
        // Store records info for both debug and clean modes (clean mode won't expose it but needs it for consistency)
        primaryRecord._debugAllRecordsInfo = {
          totalRecordCount: userRecords.length,
          activeRecordCount: activeRecords.length,
          selectedRecord: 'LAST active record',
          allRecordsBasicInfo: userRecords.map(record => ({
            employeeNumber: record.employeeNumber,
            companyCode: record.companyCode,
            firstName: record.firstName,
            lastName: record.lastName,
            status: record.status,
            hasEmploymentDetails: !!record.employmentDetails,
            employmentStatus: record.employmentDetails ? 
              (record.employmentDetails.employmentStatus === 'A' ? 'ACTIVE' : 
               record.employmentDetails.employmentStatus === 'T' ? 'TERMINATED' : 
               record.employmentDetails.employmentStatus || 'UNKNOWN') : 'UNKNOWN',
            rawEmploymentStatus: record.employmentDetails ? record.employmentDetails.employmentStatus : null,
            isSelected: record === primaryRecord,
            employmentDetailsRaw: debugMode ? (record.employmentDetails ? record.employmentDetails.rawResponse : null) : null
          })),
          activeRecordsOnly: activeRecords.map(record => ({
            employeeNumber: record.employeeNumber,
            companyCode: record.companyCode,
            employmentStatus: 'ACTIVE',
            rawEmploymentStatus: record.employmentDetails.employmentStatus,
            isSelected: record === primaryRecord
          }))
        };
        
        // Set userInfo to the primary record for backward compatibility
        userInfo = primaryRecord;
        
        // Force copy employment details to ensure they're available
        if (primaryRecord && primaryRecord.employmentDetails) {
          userInfo.employmentDetails = { ...primaryRecord.employmentDetails };
        }
      }
      
      if (userInfo) {
        // At this point, we already filtered to only active records (employmentStatus = 'A')
        console.log(`Active user confirmed: ${userInfo.employeeNumber} from company ${userInfo.companyCode}`);
        
        const response = {
          success: true,
          employeeNumber: userInfo.employeeNumber,
          companyCode: userInfo.companyCode,
          firstName: userInfo.firstName,
          lastName: userInfo.lastName,
          status: userInfo.status,
          email: emailToSearch
        };
        
        // Add employment status - we know it's active since we filtered for it
        if (userInfo.employmentDetails) {
          response.employmentStatus = 'ACTIVE';
          response.employmentStatusReason = 'Employment status: A (Active)';
          response.dataSource = 'SSO + EmployeeEmploymentInformation Services';
          
          if (userInfo.employmentDetails.hireDate) {
            response.hireDate = userInfo.employmentDetails.hireDate;
          }
          if (userInfo.employmentDetails.jobTitle) {
            response.jobTitle = userInfo.employmentDetails.jobTitle;
          }
          
          // Show selection note if multiple records were found
          if (userInfo._debugAllRecordsInfo && userInfo._debugAllRecordsInfo.totalRecordCount > 1) {
            response.note = `Selected last active record from ${userInfo._debugAllRecordsInfo.activeRecordCount} active records out of ${userInfo._debugAllRecordsInfo.totalRecordCount} total records found`;
          }
        } else {
          response.employmentStatus = 'Active (assumed - no employment details available)';
          response.dataSource = 'SSO Service Only';
          
          // Show selection note if multiple records were found
          if (userInfo._debugAllRecordsInfo && userInfo._debugAllRecordsInfo.totalRecordCount > 1) {
            response.note = `Selected record from ${userInfo._debugAllRecordsInfo.totalRecordCount} total records found (no employment status available)`;
          }
        }
        
        // Add debug information if debug mode is enabled
        if (debugMode) {
          response.debugModeEnabled = true;
          
          if (userInfo.rawSSOResponse) {
            response.rawSSOResponse = userInfo.rawSSOResponse;
          }
          if (userInfo.employmentDetails) {
            response.debugEmploymentDetails = userInfo.employmentDetails;
          }
          
          // Include all records if multiple were found (avoiding circular references)
          if (userInfo._debugAllRecordsInfo) {
            response.debugAllRecords = userInfo._debugAllRecordsInfo.allRecordsBasicInfo;
            response.debugActiveRecords = userInfo._debugAllRecordsInfo.activeRecordsOnly;
            response.debugTotalRecordCount = userInfo._debugAllRecordsInfo.totalRecordCount;
            response.debugActiveRecordCount = userInfo._debugAllRecordsInfo.activeRecordCount;
            response.debugSelectedRecord = userInfo._debugAllRecordsInfo.selectedRecord;
            response.debugMultipleRecordsFound = userInfo._debugAllRecordsInfo.totalRecordCount > 1;
            
            // Include employment details for ALL records, not just the primary one
            response.debugAllEmploymentDetails = userInfo._debugAllRecordsInfo.allRecordsBasicInfo
              .filter(record => record.hasEmploymentDetails)
              .map(record => ({
                companyCode: record.companyCode,
                employeeNumber: record.employeeNumber,
                employmentStatus: record.employmentStatus,
                rawResponse: record.employmentDetailsRaw
              }));
          }
        }
        
        return new Response(JSON.stringify(response), {
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
 * Find user by email using SSO User service - EFFICIENT VERSION
 */
async function findUserByEmail(env, token, emailToSearch, debugMode = false) {
  const ssoUserServiceUrl = `${env.UKG_BASE_URL}/services/EmployeeSsoUser`;
  
  // Use GetSsoUserByClientUserName instead of FindSsoUsers for direct email lookup
  const ssoUserEnvelope = `
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://www.w3.org/2005/08/addressing"
            xmlns:sso="http://www.ultipro.com/services/employeessouser"
            xmlns:con="http://www.ultipro.com/contracts">
  <s:Header>
    <a:Action s:mustUnderstand="1">http://www.ultipro.com/services/employeessouser/IEmployeeSsoUser/GetSsoUserByClientUserName</a:Action>
    <a:To s:mustUnderstand="1">${ssoUserServiceUrl}</a:To>
    <UltiProToken xmlns="http://www.ultimatesoftware.com/foundation/authentication/ultiprotoken">${token}</UltiProToken>
    <ClientAccessKey xmlns="http://www.ultimatesoftware.com/foundation/authentication/clientaccesskey">${env.UKG_CUSTOMER_API_KEY}</ClientAccessKey>
  </s:Header>
  <s:Body>
    <sso:GetSsoUserByClientUserName>
      <sso:clientUserName>${emailToSearch}</sso:clientUserName>
    </sso:GetSsoUserByClientUserName>
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

    // For debugging: log SSO User Service full response when debug mode is enabled
    if (debugMode) {
      console.log(`GetSsoUserByClientUserName RESPONSE:`, responseText);
    }

    // Parse XML response from GetSsoUserByClientUserName (returns single user, not all users)
    const userResult = parseSingleUserFromXML(responseText, emailToSearch);
    
    if (!userResult) {
      console.log(`GetSsoUserByClientUserName failed for ${emailToSearch} - user not found`);
      return null;
    }
    
    // For debugging: include raw response
    if (userResult && debugMode) {
      userResult.rawSSOResponse = responseText; // Include full SSO response in debug mode
      userResult.debugXML = responseText; // For single user, the whole response is the debug info
    }
    
    return userResult;
  } catch (error) {
    console.error('SSO User query error:', error);
    return null;
  }
}



/**
 * Get employment information using EmployeeEmploymentInformation service - GetEmploymentInformationByEmployeeIdentifier
 */
async function getEmploymentInformationByEmployeeIdentifier(env, token, companyCode, employeeNumber, debugMode = false) {
  const employeeEmploymentInformationServiceUrl = `${env.UKG_BASE_URL}/services/EmployeeEmploymentInformation`;
  
  console.log(`Calling EmployeeEmploymentInformation service for Company: ${companyCode}, Employee: ${employeeNumber}`);
  
  // Create SOAP envelope based on the WSDL
  const employeeEmploymentInformationEnvelope = `
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:a="http://www.w3.org/2005/08/addressing"
            xmlns:eei="http://www.ultipro.com/services/employeeemploymentinformation"
            xmlns:con="http://www.ultipro.com/contracts">
  <s:Header>
    <a:Action s:mustUnderstand="1">http://www.ultipro.com/services/employeeemploymentinformation/IEmployeeEmploymentInformation/GetEmploymentInformationByEmployeeIdentifier</a:Action>
    <a:To s:mustUnderstand="1">${employeeEmploymentInformationServiceUrl}</a:To>
    <UltiProToken xmlns="http://www.ultimatesoftware.com/foundation/authentication/ultiprotoken">${token}</UltiProToken>
    <ClientAccessKey xmlns="http://www.ultimatesoftware.com/foundation/authentication/clientaccesskey">${env.UKG_CUSTOMER_API_KEY}</ClientAccessKey>
  </s:Header>
  <s:Body>
    <eei:GetEmploymentInformationByEmployeeIdentifier>
      <eei:employeeIdentifier xmlns:i="http://www.w3.org/2001/XMLSchema-instance" i:type="con:EmployeeNumberIdentifier">
        <con:CompanyCode>${companyCode}</con:CompanyCode>
        <con:EmployeeNumber>${employeeNumber}</con:EmployeeNumber>
      </eei:employeeIdentifier>
    </eei:GetEmploymentInformationByEmployeeIdentifier>
  </s:Body>
</s:Envelope>`;

  try {
    const response = await fetch(employeeEmploymentInformationServiceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
      },
      body: employeeEmploymentInformationEnvelope,
    });

    console.log(`EmployeeEmploymentInformation service response status: ${response.status} ${response.statusText}`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`EmployeeEmploymentInformation service failed: ${response.status} ${response.statusText}`);
      if (debugMode) {
        console.log(`EmployeeEmploymentInformation FULL ERROR: ${errorText}`);
      }
      return null;
    }

    const responseText = await response.text();
    console.log(`EmployeeEmploymentInformation service SUCCESS - response length: ${responseText.length}`);
    
    // For debugging: log full response when debug mode is enabled
    if (debugMode) {
      console.log(`EmployeeEmploymentInformation FULL RESPONSE:`, responseText);
    }

    // Parse the response
    const result = parseEmploymentInformationDetailsFromXML(responseText, companyCode, employeeNumber, debugMode);
    
    if (result) {
      console.log(`*** SUCCESS: Found employment information via EmployeeEmploymentInformation service ***`);
      // In debug mode, include full response for analysis
      if (debugMode) {
        result.fullResponse = responseText;
        result.service = 'EmployeeEmploymentInformation';
      }
      return result;
    } else {
      console.log(`No employment information found`);
      if (debugMode) {
        return {
          noEmploymentInfoFound: true,
          rawResponse: responseText,
          serviceName: 'EmployeeEmploymentInformation-GetEmploymentInformationByEmployeeIdentifier',
          interpretAs: 'No employment information available'
        };
      }
      return null;
    }
    
  } catch (error) {
    console.error('EmployeeEmploymentInformation service error:', error);
    if (debugMode) {
      return {
        error: true,
        errorMessage: error.message,
        serviceName: 'EmployeeEmploymentInformation-GetEmploymentInformationByEmployeeIdentifier'
      };
    }
    return null;
  }
}

/**
 * Parse employment information details from EmployeeEmploymentInformation service XML response
 */
function parseEmploymentInformationDetailsFromXML(xmlText, companyCode, employeeNumber, debugMode = false) {
  try {
    console.log(`\n=== EMPLOYEEEMPLOYMENTINFORMATION SERVICE RESPONSE FOR ${companyCode}-${employeeNumber} ===`);
    
    // Look for the GetEmploymentInformationByEmployeeIdentifierResult - try both namespace formats
    let resultMatch = xmlText.match(/<b:GetEmploymentInformationByEmployeeIdentifierResult>(.*?)<\/b:GetEmploymentInformationByEmployeeIdentifierResult>/s);
    if (!resultMatch) {
      // Try without namespace prefix
      resultMatch = xmlText.match(/<GetEmploymentInformationByEmployeeIdentifierResult[^>]*>(.*?)<\/GetEmploymentInformationByEmployeeIdentifierResult>/s);
    }
    if (!resultMatch) {
      console.log('No GetEmploymentInformationByEmployeeIdentifierResult found in response (tried both namespace formats)');
      if (debugMode) {
        console.log('Full XML response for debugging:');
        console.log(xmlText.substring(0, 1000) + '...');
      }
      return null;
    }
    
    const resultBlock = resultMatch[1];
    
    // Check if the operation was successful - try both namespace formats
    let successMatch = resultBlock.match(/<b:Success>([^<]+)<\/b:Success>/);
    if (!successMatch) {
      successMatch = resultBlock.match(/<Success>([^<]+)<\/Success>/);
    }
    if (debugMode) {
      console.log('Success match result:', successMatch);
    }
    if (successMatch && successMatch[1] !== 'true') {
      console.log('EmployeeEmploymentInformation lookup was not successful');
      return null;
    }
    
    // Look for the Results block containing employment information data - try both namespace formats
    let resultsMatch = resultBlock.match(/<b:Results>(.*?)<\/b:Results>/s);
    if (!resultsMatch) {
      resultsMatch = resultBlock.match(/<Results>(.*?)<\/Results>/s);
    }
    if (debugMode) {
      console.log('Results match found:', !!resultsMatch);
      if (resultsMatch) {
        console.log('Results content preview:', resultsMatch[1].substring(0, 200));
      }
    }
    if (!resultsMatch) {
      console.log('No Results found in EmployeeEmploymentInformation response (tried both namespace formats)');
      return null;
    }

    // Look for EmploymentInformation block within Results - try both namespace formats
    let employmentInfoMatch = resultsMatch[1].match(/<b:EmploymentInformation>(.*?)<\/b:EmploymentInformation>/s);
    if (!employmentInfoMatch) {
      employmentInfoMatch = resultsMatch[1].match(/<EmploymentInformation>(.*?)<\/EmploymentInformation>/s);
    }
    if (debugMode) {
      console.log('EmploymentInformation match found:', !!employmentInfoMatch);
      if (employmentInfoMatch) {
        console.log('EmploymentInformation content preview:', employmentInfoMatch[1].substring(0, 200));
      }
    }
    if (!employmentInfoMatch) {
      console.log('No EmploymentInformation found in Results (tried both namespace formats)');
      return null;
    }

    const employmentData = employmentInfoMatch[1];
    
    if (debugMode) {
      console.log(`*** EMPLOYMENT DATA TO PARSE (first 500 chars): ${employmentData.substring(0, 500)} ***`);
    }
    
    // Extract employment details
    const fields = {};
    
    // Employment information patterns - try both with and without namespace prefix
    const patternNames = [
      'employmentStatus', 'status', 'employeeStatus', 'employeeStatusCode', 'statusCode',
      'hireDate', 'startDate', 'employmentStartDate', 'terminationDate', 'endDate', 'employmentEndDate', 'lastWorkDate',
      'jobTitle', 'title', 'position', 'department', 'departmentCode',
      'employmentType', 'employeeType', 'workerType',
      'isActive', 'active',
      'employeeId', 'employeeNumber', 'companyCode'
    ];
    
    // Function to try both namespace formats
    function extractFieldValue(data, fieldName) {
      const capitalizedField = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
      
      // Try with b: namespace prefix first
      let pattern = new RegExp(`<b:${capitalizedField}>([^<]*)<\/b:${capitalizedField}>`, 'i');
      let match = data.match(pattern);
      
      if (!match) {
        // Try without namespace prefix
        pattern = new RegExp(`<${capitalizedField}>([^<]*)<\/${capitalizedField}>`, 'i');
        match = data.match(pattern);
      }
      
      return match && match[1] ? match[1].trim() : null;
    }
    
    // Extract all available fields
    for (const fieldName of patternNames) {
      const value = extractFieldValue(employmentData, fieldName);
      if (value && value !== '') {
        fields[fieldName] = value;
        if (debugMode && fieldName === 'employmentStatus') {
          console.log(`*** EMPLOYMENT STATUS EXTRACTED: ${fieldName} = ${value} ***`);
        }
      } else if (debugMode && fieldName === 'employmentStatus') {
        console.log(`*** NO MATCH for ${fieldName} ***`);
        console.log(`*** Employment data preview: ${employmentData.substring(0, 200)} ***`);
      }
    }
    
    // Special handling for employment status if not found by field extraction
    if (!fields.employmentStatus) {
      // Try a broader search in the entire XML response
      let directMatch = xmlText.match(/<b:EmploymentStatus>([^<]*)<\/b:EmploymentStatus>/i);
      if (!directMatch) {
        directMatch = xmlText.match(/<EmploymentStatus>([^<]*)<\/EmploymentStatus>/i);
      }
      if (directMatch && directMatch[1]) {
        fields.employmentStatus = directMatch[1].trim();
        if (debugMode) {
          console.log(`*** EMPLOYMENT STATUS FOUND BY DIRECT XML SEARCH: ${directMatch[1]} ***`);
        }
      }
    }
    
    // In debug mode, extract ALL fields from the employment data
    if (debugMode) {
      fields.allDetectedFields = extractAllFieldsFromBlock(employmentData);
      fields.rawEmploymentData = `<EmploymentInformation>${employmentData}</EmploymentInformation>`;
    }
    
    // Log what we found
    const foundFields = Object.keys(fields).filter(key => !['allDetectedFields', 'rawEmploymentData'].includes(key));
    console.log(`Extracted employment fields: ${foundFields.join(', ')}`);

    if (fields.employmentStatus) {
      console.log(`*** EMPLOYMENT STATUS FOUND: ${fields.employmentStatus} ***`);
    }
    if (fields.terminationDate) {
      console.log(`*** TERMINATION DATE FOUND: ${fields.terminationDate} ***`);
    }

    console.log('=== END EMPLOYEEEMPLOYMENTINFORMATION SERVICE RESPONSE ===\n');

    // Always return the employment data if we have any fields or if the service call was successful
    return {
      ...fields,
      serviceName: 'EmployeeEmploymentInformation-GetEmploymentInformationByEmployeeIdentifier',
      rawResponse: xmlText
    };
    
  } catch (error) {
    console.error('Error parsing EmployeeEmploymentInformation XML response:', error);
    return null;
  }
}

/**
 * Parse single user XML response from GetSsoUserByClientUserName
 */
function parseSingleUserFromXML(xmlText, emailToSearch) {
  try {
    console.log(`Parsing single user response for: ${emailToSearch}`);
    
    // Look for the single SsoUser result - try both namespace formats
    let ssoUserMatch = xmlText.match(/<b:GetSsoUserByClientUserNameResult>(.*?)<\/b:GetSsoUserByClientUserNameResult>/s);
    if (!ssoUserMatch) {
      ssoUserMatch = xmlText.match(/<GetSsoUserByClientUserNameResult[^>]*>(.*?)<\/GetSsoUserByClientUserNameResult>/s);
    }
    if (!ssoUserMatch) {
      console.log('No GetSsoUserByClientUserNameResult found in response (tried both namespace formats)');
      return null;
    }
    
    const resultBlock = ssoUserMatch[1];
    
    // Check if the operation was successful - try both namespace formats
    let successMatch = resultBlock.match(/<b:Success>([^<]+)<\/b:Success>/);
    if (!successMatch) {
      successMatch = resultBlock.match(/<Success>([^<]+)<\/Success>/);
    }
    if (successMatch && successMatch[1] !== 'true') {
      console.log('SSO User lookup was not successful');
      return null;
    }
    
    // Extract the SsoUser from Results - try both namespace formats
    let ssoUserDataMatch = resultBlock.match(/<b:Results>(.*?)<\/b:Results>/s);
    if (!ssoUserDataMatch) {
      ssoUserDataMatch = resultBlock.match(/<Results>(.*?)<\/Results>/s);
    }
    if (!ssoUserDataMatch) {
      console.log('No Results found in response (tried both namespace formats)');
      return null;
    }
    
    const ssoUserData = ssoUserDataMatch[1];
    
    // Helper function to extract field values with flexible namespace handling
    function extractFieldValue(data, fieldName) {
      const capitalizedField = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
      
      // Try with b: namespace prefix first
      let pattern = new RegExp(`<b:${capitalizedField}>([^<]*)<\/b:${capitalizedField}>`, 'i');
      let match = data.match(pattern);
      
      if (!match) {
        // Try without namespace prefix
        pattern = new RegExp(`<${capitalizedField}>([^<]*)<\/${capitalizedField}>`, 'i');
        match = data.match(pattern);
      }
      
      return match && match[1] ? match[1].trim() : '';
    }
    
    // Extract SSO user fields
    const clientUserName = extractFieldValue(ssoUserData, 'clientUserName');
    const ultiProUserName = extractFieldValue(ssoUserData, 'ultiProUserName');
    const status = extractFieldValue(ssoUserData, 'status');
    
    // Extract employee identifier info - try both namespace formats
    let employeeIdMatch = ssoUserData.match(/<b:EmployeeIdentifier[^>]*>(.*?)<\/b:EmployeeIdentifier>/s);
    if (!employeeIdMatch) {
      employeeIdMatch = ssoUserData.match(/<EmployeeIdentifier[^>]*>(.*?)<\/EmployeeIdentifier>/s);
    }
    
    let companyCode = '';
    let employeeNumber = '';
    let firstName = '';
    let lastName = '';
    
    if (employeeIdMatch) {
      const empIdBlock = employeeIdMatch[1];
      companyCode = extractFieldValue(empIdBlock, 'companyCode');
      employeeNumber = extractFieldValue(empIdBlock, 'employeeNumber');
    }
    
    // Try to extract names from various possible locations
    firstName = extractFieldValue(ssoUserData, 'firstName') || 
                extractFieldValue(ssoUserData, 'givenName') || 
                extractFieldValue(ssoUserData, 'firstNm') || '';
                
    lastName = extractFieldValue(ssoUserData, 'lastName') || 
               extractFieldValue(ssoUserData, 'surname') || 
               extractFieldValue(ssoUserData, 'lastNm') || 
               extractFieldValue(ssoUserData, 'familyName') || '';
    
    // Note: GetSsoUserByClientUserName might not return first/last name directly
    // We may need to get that from a separate call or it might be in a different location
    
    const result = {
      employeeNumber: employeeNumber,
      companyCode: companyCode,
      firstName: firstName,
      lastName: lastName,
      status: status || '1',
      clientUserName: clientUserName || emailToSearch,
      ultiProUserName: ultiProUserName || emailToSearch
    };
    
    console.log(`Found SSO user: Employee ${result.employeeNumber}, Company: ${result.companyCode}, Status: ${result.status}`);
    return result;
    
  } catch (error) {
    console.error('Error parsing single user XML:', error);
    return null;
  }
}
