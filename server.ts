// =================================================================
// 1. TOP-LEVEL LOG: To check if this file is being executed at all
// =================================================================
console.log('--- EXECUTING server.ts ---');

import { metorial, z } from '@metorial/mcp-server-sdk';
import { URLSearchParams } from 'node:url'; // CORRECTED: Added 'node:' prefix
import { Buffer } from 'node:buffer'; // CORRECTED: Added 'node:' prefix

/**
 * Twilio MCP Server
 * Provides capabilities to send messages via the Twilio API
 */

// Define the configuration the server needs
type TwilioConfig = {
  accountSid: string;
  apiKey: string;
  apiSecret: string;
};

metorial.createServer<TwilioConfig>(
  {
    name: 'twilio-message-server',
    version: '1.0.0',
    // Instructions are now part of the server config
    instructions: `You are an agent to call Twilio APIs. If no accountSid is provided, you MUST use ${process.env.TWILIO_ACCOUNT_SID || 'your default AccountSid'}.`,
  },
  async (server, config) => {
    
    // =================================================================
    // 2. STARTUP LOG: To check if config is being passed in
    // =================================================================
    console.log('[Server Startup] Server is initializing. Config:', config);
    
    // 3. Define Constants and API Base URL
    const API_BASE_URL = 'https://api.twilio.com/2010-04-01';

    // ============================================================================
    // Type Definitions
    // ============================================================================

    interface TwilioMessageResponse {
      sid: string;
      status: string;
      to: string;
      from: string;
      body: string | null;
      num_media: string;
      error_code: number | null;
      error_message: string | null;
      direction: string;
      price: string | null;
      uri: string;
      [key: string]: any;
    }

    interface TwilioError {
      code: number;
      message: string;
      more_info: string;
      status: number;
    }

    // ============================================================================
    // Schema Definitions (for the 'send_message' tool)
    // ============================================================================

    const sendMessageSchema = {
      To: z
        .string()
        .describe(
          "Required. The recipient's phone number in E.164 format (e.g., +15552229999).",
        ),
      From: z
        .string()
        .optional()
        .describe(
          "Required if 'MessagingServiceSid' is not passed. The sender's Twilio phone number (in E.164 format).",
        ),
      MessagingServiceSid: z
        .string()
        .regex(/^MG[0-9a-fA-F]{32}$/)
        .optional()
        .describe(
          "Required if 'From' is not passed. The SID of the Messaging Service.",
        ),
      Body: z
        .string()
        .max(1600)
        .optional()
        .describe(
          "Required if 'MediaUrl' or 'ContentSid' is not passed. The text content of the message.",
        ),
      MediaUrl: z
        .array(z.string().url())
        .max(10)
        .optional()
        .describe(
          "Required if 'Body' or 'ContentSid' is not passed. An array of URLs for media (up to 10).",
        ),
      ContentSid: z
        .string()
        .regex(/^HX[0-9a-fA-F]{32}$/)
        .optional()
        .describe(
          "Required if 'Body' or 'MediaUrl' is not passed. The SID of a Content Template.",
        ),
      StatusCallback: z
        .string()
        .url()
        .optional()
        .describe(
          'The URL to which Twilio will send Message status callback requests.',
        ),
      ValidityPeriod: z
        .number()
        .min(1)
        .max(36000)
        .optional()
        .describe(
          'The maximum time in seconds (1-36000) the Message can remain in the queue. Default is 36000.',
        ),
    };

    // ============================================================================
    // Helper Function (With Enhanced Logging)
    // ============================================================================

    /**
     * Makes an authenticated request to the Twilio API.
     * Handles Basic Auth and form-urlencoded bodies.
     * [WITH ENHANCED LOGGING]
     */
    async function twilioRequest<T>(
      endpoint: string, // e.g., /Accounts/{AccountSid}/Messages.json
      method: 'POST' | 'GET',
      body: Record<string, any> = {},
    ): Promise<T> {
      const url = `${API_BASE_URL}${endpoint}`;
      console.log(`[twilioRequest] Making ${method} request to: ${url}`);
      
      // Check for config object before trying to access its properties
      if (!config || !config.apiKey || !config.apiSecret) {
        console.error('[twilioRequest] CRITICAL: Twilio config is missing or incomplete.');
        throw new Error('Server configuration for Twilio is missing.');
      }

      // 1. Create Basic Auth token
      const authToken = Buffer.from(
        `${config.apiKey}:${config.apiSecret}`,
      ).toString('base64');

      // 2. Serialize body as application/x-www-form-urlencoded
      const formData = new URLSearchParams();
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          value.forEach((v) => formData.append(key, String(v)));
        } else {
          formData.append(key, String(value));
        }
      }
      const requestBody = formData.toString();
      if (requestBody) {
        console.log(`[twilioRequest] Sending body: ${requestBody}`);
      }

      try {
        // 3. Make the fetch request
        const response = await fetch(url, {
          method: method,
          headers: {
            Authorization: `Basic ${authToken}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: method === 'POST' ? requestBody : undefined,
        });

        // 4. Handle errors
        if (!response.ok) {
          console.error(
            `[twilioRequest] API Error: ${response.status} ${response.statusText}`,
          );
          const errorText = await response.text();
          console.error(`[twilioRequest] Error Response Body: ${errorText}`);
          
          let errorMessage = errorText;
          try {
            const errorData = JSON.parse(errorText) as TwilioError;
            if (errorData.message) {
              errorMessage = `Code ${errorData.code}: ${errorData.message} (More info: ${errorData.more_info})`;
            }
          } catch (e) {
             // Not a JSON error, use raw text
          }
          throw new Error(errorMessage);
        }

        // 5. Success
        console.log(`[twilioRequest] Request successful.`);
        return (await response.json()) as T;
        
      } catch (error) {
        console.error('[twilioRequest] Fetch failed:', error);
        throw error;
      }
    }

    // ============================================================================
    // Tool: send_message
    // ============================================================================

    server.registerTool(
      'send_message',
      {
        title: 'Send Message',
        description:
          "Sends a new outgoing SMS or MMS message using the Twilio API. You must provide 'To' and one of ('From', 'MessagingServiceSid') and one of ('Body', 'MediaUrl', 'ContentSid').",
        inputSchema: sendMessageSchema,
      },
      async (params) => {
        try {
          // Check for config object
          if (!config || !config.accountSid) {
            console.error('[send_message] CRITICAL: Twilio AccountSid is missing from config.');
            throw new Error('Server configuration for Twilio is missing.');
          }

          const endpoint = `/Accounts/${config.accountSid}/Messages.json`;
          
          const response = await twilioRequest<TwilioMessageResponse>(
            endpoint,
            'POST',
            params,
          );

          // Format the response for the AI
          const responseText = [
            `Message sent successfully!`,
            `SID: ${response.sid}`,
            `Status: ${response.status}`,
            `To: ${response.to}`,
            `From: ${response.from}`,
          ];
          if (response.error_message) {
            responseText.push(`Error: ${response.error_message}`);
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: responseText.join('\n'),
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error sending message: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            ],
            isError: true,
          };
        }
      },
    );
  },
);
