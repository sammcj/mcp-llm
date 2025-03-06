#!/usr/bin/env node

/**
 * MCP server that provides access to LLMs using the LlamaIndexTS library.
 * It implements tools for generating code, documentation, and answering questions.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { ChatMessage, MessageContent, ChatResponse } from "llamaindex";
import { OpenAI } from "@llamaindex/openai";
import { Ollama } from "@llamaindex/ollama";
import { Bedrock, BEDROCK_MODELS } from "@llamaindex/community";
import fs from "fs";
import path from "path";

/**
 * Environment variable configuration for the LLM
 */
interface LLMConfig {
  modelName: string;
  modelProvider: string;
  baseURL?: string;
  temperature?: number;
  numCtx?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repetitionPenalty?: number;
  systemPromptGenerateCode?: string;
  systemPromptGenerateDocumentation?: string;
  systemPromptAskQuestion?: string;
  timeoutS?: number;
  allowFileWrite?: boolean;
}

/**
 * Get configuration from environment variables
 */
function getConfig(): LLMConfig {
  return {
    modelName: process.env.LLM_MODEL_NAME || "",
    modelProvider: process.env.LLM_MODEL_PROVIDER || "",
    baseURL: process.env.LLM_BASE_URL,
    temperature: process.env.LLM_TEMPERATURE ? parseFloat(process.env.LLM_TEMPERATURE) : undefined,
    numCtx: process.env.LLM_NUM_CTX ? parseInt(process.env.LLM_NUM_CTX) : undefined,
    topP: process.env.LLM_TOP_P ? parseFloat(process.env.LLM_TOP_P) : undefined,
    topK: process.env.LLM_TOP_K ? parseInt(process.env.LLM_TOP_K) : undefined,
    minP: process.env.LLM_MIN_P ? parseFloat(process.env.LLM_MIN_P) : undefined,
    repetitionPenalty: process.env.LLM_REPETITION_PENALTY ? parseFloat(process.env.LLM_REPETITION_PENALTY) : undefined,
    systemPromptGenerateCode: process.env.LLM_SYSTEM_PROMPT_GENERATE_CODE,
    systemPromptGenerateDocumentation: process.env.LLM_SYSTEM_PROMPT_GENERATE_DOCUMENTATION,
    systemPromptAskQuestion: process.env.LLM_SYSTEM_PROMPT_ASK_QUESTION,
    timeoutS: process.env.LLM_TIMEOUT_S ? parseInt(process.env.LLM_TIMEOUT_S) : undefined,
    allowFileWrite: process.env.LLM_ALLOW_FILE_WRITE ? process.env.LLM_ALLOW_FILE_WRITE.toLowerCase() === 'true' : false
  };
}

/**
 * Create an LLM instance based on the configuration
 */
function createLLM(config: LLMConfig, systemPrompt?: string) {
  const { modelName, modelProvider, baseURL, ...inferenceParams } = config;

  if (!modelName) {
    throw new McpError(ErrorCode.InternalError, "Model name is required");
  }

  if (!modelProvider) {
    throw new McpError(ErrorCode.InternalError, "Model provider is required");
  }

  // Filter out undefined values from inferenceParams
  const filteredParams: Record<string, any> = {};
  Object.entries(inferenceParams).forEach(([key, value]) => {
    if (value !== undefined && !key.startsWith("systemPrompt") && key !== "allowFileWrite") {
      filteredParams[key] = value;
    }
  });

  switch (modelProvider.toLowerCase()) {
    case "bedrock":
      return new Bedrock({
        model: modelName,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...filteredParams
      });

    case "ollama":
      // Log the configuration
      console.error(`Creating Ollama instance with model: "${modelName}"`);
      console.error(`Using Ollama host: "${baseURL || "http://localhost:11434"}"`);
      console.error(`System prompt: ${systemPrompt ? `"${systemPrompt}"` : "none"}`);
      console.error(`Additional parameters:`, filteredParams);

      try {
        // Create Ollama instance with model name and config
        const ollama = new Ollama({
          model: modelName,
          config: {
            host: baseURL || "http://localhost:11434"
          },
          ...(systemPrompt ? { systemPrompt } : {}),
          ...filteredParams
        });

        console.error(`Ollama instance created successfully`);
        return ollama;
      } catch (error) {
        console.error(`Error creating Ollama instance:`, error);
        throw error;
      }

    case "openai":
    case "openai-compatible":
      return new OpenAI({
        model: modelName,
        apiKey: process.env.OPENAI_API_KEY || "dummy-key",
        ...(baseURL ? { baseUrl: baseURL } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...filteredParams
      });

    default:
      throw new McpError(
        ErrorCode.InternalError,
        `Unsupported model provider: ${modelProvider}`
      );
  }
}

/**
 * Main class for the LlamaIndex MCP server
 */
class LlamaIndexServer {
  private server: Server;
  private config: LLMConfig;

  constructor() {
    this.config = getConfig();

    // Validate required configuration
    if (!this.config.modelName) {
      console.error("Error: LLM_MODEL_NAME environment variable is required");
      process.exit(1);
    }

    if (!this.config.modelProvider) {
      console.error("Error: LLM_MODEL_PROVIDER environment variable is required");
      process.exit(1);
    }

    this.server = new Server(
      {
        name: "mcp-llm",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  /**
   * Set up the tool handlers for the MCP server
   */
  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "generate_code",
          description: "Generate code based on a description",
          inputSchema: {
            type: "object",
            properties: {
              description: {
                type: "string",
                description: "Description of the code to generate",
              },
              language: {
                type: "string",
                description: "Programming language (e.g., JavaScript, Python, TypeScript)",
              },
              additionalContext: {
                type: "string",
                description: "Additional context or requirements for the code",
              },
            },
            required: ["description"],
          },
        },
        {
          name: "generate_code_to_file",
          description: "Generate code and write it directly to a file at a specific line number",
          inputSchema: {
            type: "object",
            properties: {
              description: {
                type: "string",
                description: "Description of the code to generate",
              },
              language: {
                type: "string",
                description: "Programming language (e.g., JavaScript, Python, TypeScript)",
              },
              additionalContext: {
                type: "string",
                description: "Additional context or requirements for the code",
              },
              filePath: {
                type: "string",
                description: "Path to the file where the code should be written",
              },
              lineNumber: {
                type: "number",
                description: "Line number where the code should be inserted (0-based)",
              },
              replaceLines: {
                type: "number",
                description: "Number of lines to replace (0 for insertion only)",
              },
            },
            required: ["description", "filePath", "lineNumber"],
          },
        },
        {
          name: "generate_documentation",
          description: "Generate documentation for code",
          inputSchema: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "Code to document",
              },
              language: {
                type: "string",
                description: "Programming language of the code",
              },
              format: {
                type: "string",
                description: "Documentation format (e.g., JSDoc, Markdown)",
              },
            },
            required: ["code"],
          },
        },
        {
          name: "ask_question",
          description: "Ask a question to the LLM",
          inputSchema: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "Question to ask",
              },
              context: {
                type: "string",
                description: "Additional context for the question",
              },
            },
            required: ["question"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case "generate_code":
            return await this.handleGenerateCode(request.params.arguments);
          case "generate_code_to_file":
            return await this.handleGenerateCodeToFile(request.params.arguments);
          case "generate_documentation":
            return await this.handleGenerateDocumentation(request.params.arguments);
          case "ask_question":
            return await this.handleAskQuestion(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        console.error("Error handling tool call:", error);
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  /**
   * Handle the generate_code tool
   */
  private async handleGenerateCode(args: any): Promise<any> {
    if (!args?.description) {
      throw new McpError(ErrorCode.InvalidParams, "Description is required");
    }

    const language = args.language || "JavaScript";
    const additionalContext = args.additionalContext || "";

    try {
      const llm = createLLM(this.config, this.config.systemPromptGenerateCode);

      const messages: ChatMessage[] = [
        {
          role: "user",
          content: `Generate ${language} code for the following description:\n\n${args.description}\n\n${additionalContext ? `Additional context:\n${additionalContext}` : ""}`,
        },
      ];

      const response = await llm.chat({ messages });
      return {
        content: [
          {
            type: "text",
            text: response.message.content,
          },
        ],
      };
    } catch (error) {
      console.error("Error in handleGenerateCode:", error);

      // Return a helpful error message
      return {
        content: [
          {
            type: "text",
            text: `Error generating code: ${error instanceof Error ? error.message : String(error)}\n\nPlease check that the model "${this.config.modelName}" is available on your Ollama server at "${this.config.baseURL || 'http://localhost:11434'}".\n\nYou may need to pull the model first using: ollama pull ${this.config.modelName}`,
          },
        ],
        isError: true
      };
    }
  }

  /**
   * Handle the generate_documentation tool
   */
  private async handleGenerateDocumentation(args: any): Promise<any> {
    if (!args?.code) {
      throw new McpError(ErrorCode.InvalidParams, "Code is required");
    }

    const language = args.language || "JavaScript";
    const format = args.format || "Markdown";

    try {
      // Check if the model name might have a suffix
      let modelName = this.config.modelName;

      // Try with the original model name
      try {
        console.error(`Attempting to use model: "${modelName}"`);
        const llm = createLLM({...this.config, modelName}, this.config.systemPromptGenerateDocumentation);

        const messages: ChatMessage[] = [
          {
            role: "user",
            content: `Generate ${format} documentation for the following ${language} code:\n\n\`\`\`${language}\n${args.code}\n\`\`\``,
          },
        ];

        const response = await llm.chat({ messages });
        return {
          content: [
            {
              type: "text",
              text: response.message.content,
            },
          ],
        };
      } catch (originalError) {
        console.error(`Error with original model name "${modelName}":`, originalError);

        // If the model name contains a suffix, try without it
        if (modelName.includes("_")) {
          const baseModelName = modelName.split("_")[0];
          console.error(`Trying with base model name: "${baseModelName}"`);

          try {
            const llm = createLLM({...this.config, modelName: baseModelName}, this.config.systemPromptGenerateDocumentation);

            const messages: ChatMessage[] = [
              {
                role: "user",
                content: `Generate ${format} documentation for the following ${language} code:\n\n\`\`\`${language}\n${args.code}\n\`\`\``,
              },
            ];

            const response = await llm.chat({ messages });
            return {
              content: [
                {
                  type: "text",
                  text: response.message.content,
                },
              ],
            };
          } catch (baseModelError) {
            console.error(`Error with base model name "${baseModelName}":`, baseModelError);
            throw originalError; // Throw the original error
          }
        } else {
          throw originalError;
        }
      }
    } catch (error) {
      console.error("Error in handleGenerateDocumentation:", error);

      // Return a helpful error message
      return {
        content: [
          {
            type: "text",
            text: `Error generating documentation: ${error instanceof Error ? error.message : String(error)}\n\nPlease check that the model "${this.config.modelName}" is available on your Ollama server at "${this.config.baseURL || 'http://localhost:11434'}".\n\nYou may need to pull the model first using: ollama pull ${this.config.modelName}`,
          },
        ],
        isError: true
      };
    }
  }

  /**
   * Handle the ask_question tool
   */
  private async handleAskQuestion(args: any): Promise<any> {
    if (!args?.question) {
      throw new McpError(ErrorCode.InvalidParams, "Question is required");
    }

    const context = args.context || "";

    try {
      const llm = createLLM(this.config, this.config.systemPromptAskQuestion);

      const messages: ChatMessage[] = [
        {
          role: "user",
          content: `${args.question}${context ? `\n\nContext:\n${context}` : ""}`,
        },
      ];

      const response = await llm.chat({ messages });
      return {
        content: [
          {
            type: "text",
            text: response.message.content,
          },
        ],
      };
    } catch (error) {
      console.error("Error in handleAskQuestion:", error);

      // Return a helpful error message
      return {
        content: [
          {
            type: "text",
            text: `Error answering question: ${error instanceof Error ? error.message : String(error)}\n\nPlease check that the model "${this.config.modelName}" is available on your Ollama server at "${this.config.baseURL || 'http://localhost:11434'}".\n\nYou may need to pull the model first using: ollama pull ${this.config.modelName}`,
          },
        ],
        isError: true
      };
    }
  }

  /**
   * Handle the generate_code_to_file tool
   */
  private async handleGenerateCodeToFile(args: any): Promise<any> {
    if (!args?.description) {
      throw new McpError(ErrorCode.InvalidParams, "Description is required");
    }

    if (!args?.filePath) {
      throw new McpError(ErrorCode.InvalidParams, "File path is required");
    }

    if (args.lineNumber === undefined || args.lineNumber === null) {
      throw new McpError(ErrorCode.InvalidParams, "Line number is required");
    }

    // Check if file writing is allowed
    if (!this.config.allowFileWrite) {
      return {
        content: [
          {
            type: "text",
            text: `Error: File writing is not allowed. Set LLM_ALLOW_FILE_WRITE=true in your environment variables to enable this feature.`,
          },
        ],
        isError: true
      };
    }

    const language = args.language || "JavaScript";
    const additionalContext = args.additionalContext || "";

    // Log original path and current working directory
    const originalPath = args.filePath
    const cwd = process.cwd()
    console.error(`Original file path: ${originalPath}`)
    console.error(`Current working directory: ${cwd}`);

    // Ensure we have a fully qualified file path
    const filePath = path.isAbsolute(originalPath) ? originalPath : path.resolve(cwd, originalPath)
    console.error(`Resolved file path: ${filePath}`)

    // Check if the file and directory exist and are writable
    const directory = path.dirname(filePath)
    console.error(`Directory: ${directory}`)
    console.error(`Directory exists: ${fs.existsSync(directory)}`)

    if (fs.existsSync(filePath)) {
      console.error(`File exists: true`)
      try {
        fs.accessSync(filePath, fs.constants.W_OK)
        console.error(`File is writable: true`)
      } catch (error) {
        console.error(`File is writable: false - ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      console.error(`File exists: false`)
      try {
        fs.accessSync(directory, fs.constants.W_OK)
        console.error(`Directory is writable: true`)
      } catch (error) {
        console.error(`Directory is writable: false - ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const lineNumber = parseInt(args.lineNumber, 10);
    const replaceLines = args.replaceLines ? parseInt(args.replaceLines, 10) : 0;

    try {
      // Generate code using the LLM
      const llm = createLLM(this.config, this.config.systemPromptGenerateCode);

      const messages: ChatMessage[] = [
        {
          role: "user",
          content: `Generate ${language} code for the following description:\n\n${args.description}\n\n${additionalContext ? `Additional context:\n${additionalContext}` : ""}`,
        },
      ];

      console.error(`Generating code for file: ${filePath} at line: ${lineNumber}`);
      const response = await llm.chat({ messages });

      // Convert the message content to a string
      let generatedCode = "";
      if (typeof response.message.content === "string") {
        generatedCode = response.message.content;
      } else if (Array.isArray(response.message.content)) {
        // If it's an array of MessageContentDetail, concatenate text parts
        generatedCode = response.message.content
          .filter(item => item.type === "text")
          .map(item => item.text)
          .join("\n");
      }

      // Extract code from markdown code blocks if present
      let codeToInsert = generatedCode;
      const codeBlockRegex = /```(?:\w+)?\n([\s\S]+?)\n```/;
      const match = codeBlockRegex.exec(generatedCode);
      if (match && match[1]) {
        codeToInsert = match[1];
      }

      // Make sure the directory exists
      const directory = path.dirname(filePath);
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
      }

      // Read the file if it exists, or create an empty file
      let fileContent = "";
      try {
        fileContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
      } catch (error) {
        console.error(`Error reading file ${filePath}:`, error);
        return {
          content: [
            {
              type: "text",
              text: `Error reading file: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true
        };
      }

      // Split the file content into lines
      const lines = fileContent.split("\n");

      // Ensure lineNumber is within bounds
      const safeLineNumber = Math.max(0, Math.min(lineNumber, lines.length));

      // Split the generated code into lines
      const codeLines = codeToInsert.split("\n");

      // Remove lines to be replaced if specified
      if (replaceLines > 0) {
        lines.splice(safeLineNumber, replaceLines, ...codeLines);
      } else {
        // Insert the generated code at the specified line
        lines.splice(safeLineNumber, 0, ...codeLines);
      }

      // Join the lines back together
      const updatedContent = lines.join("\n");

      // Write the updated content back to the file
      try {
        fs.writeFileSync(filePath, updatedContent, "utf-8");
      } catch (error) {
        console.error(`Error writing to file ${filePath}:`, error);
        return {
          content: [
            {
              type: "text",
              text: `Error writing to file: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully generated and inserted code into ${filePath} at line ${safeLineNumber}.\n\nGenerated code:\n\`\`\`${language}\n${codeToInsert}\n\`\`\``,
          },
        ],
      };
    } catch (error) {
      console.error("Error in handleGenerateCodeToFile:", error);

      // Return a helpful error message
      return {
        content: [
          {
            type: "text",
            text: `Error generating code to file: ${error instanceof Error ? error.message : String(error)}\n\nPlease check that the model "${this.config.modelName}" is available on your Ollama server at "${this.config.baseURL || 'http://localhost:11434'}".\n\nYou may need to pull the model first using: ollama pull ${this.config.modelName}`,
          },
        ],
        isError: true
      };
    }
  }

  /**
   * Start the server
   */
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("LlamaIndex MCP server running on stdio");
  }
}

// Start the server
const server = new LlamaIndexServer();
server.run().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
