#!/usr/bin/env node

/**
 * Example script demonstrating how to use the MCP LLM server programmatically.
 *
 * This script shows how to call the MCP server using curl commands.
 */

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Get the directory name of the current module
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the MCP server
const serverPath = path.join(__dirname, '..', 'build', 'index.js');

// Environment variables for the MCP server
const env = {
  ...process.env,
  LLM_MODEL_NAME: 'deepseek-r1:14b-qwen-distill-q6_k',
  LLM_MODEL_PROVIDER: 'ollama',
  LLM_TEMPERATURE: '0.2',
  LLM_TOP_P: '0.9',
};

/**
 * Start the MCP server as a child process
 */
function startServer() {
  console.log('Starting MCP server...');
  const server = spawn('node', [serverPath], {
    env,
    stdio: 'inherit',
  });

  // Give the server some time to start
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(server);
    }, 2000);
  });
}

/**
 * Send a request to the MCP server using curl
 */
function sendRequest(method, params) {
  const command = `curl -s -X POST -H "Content-Type: application/json" -d '${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  })}' http://localhost:3000`;

  try {
    const result = execSync(command, { encoding: 'utf-8' });
    return JSON.parse(result);
  } catch (error) {
    console.error('Error sending request:', error.message);
    return null;
  }
}

/**
 * Main function
 */
async function main() {
  // Start the server
  const server = await startServer();

  try {
    // List available tools
    console.log('\nListing available tools:');
    const toolsResponse = sendRequest('listTools', {});
    console.log(JSON.stringify(toolsResponse, null, 2));

    // Generate code
    console.log('\nGenerating code:');
    const codeResult = sendRequest('callTool', {
      name: 'generate_code',
      arguments: {
        description: 'Create a function that calculates the factorial of a number',
        language: 'JavaScript',
      },
    });
    console.log(JSON.stringify(codeResult, null, 2));

    // Generate code to file
    console.log('\nGenerating code to file:');
    const tempFilePath = path.join(__dirname, 'temp-factorial.js');
    const codeToFileResult = sendRequest('callTool', {
      name: 'generate_code_to_file',
      arguments: {
        description: 'Create a function that calculates the factorial of a number',
        language: 'JavaScript',
        filePath: tempFilePath,
        lineNumber: 0,
        replaceLines: 0,
      },
    });
    console.log(JSON.stringify(codeToFileResult, null, 2));

    // Check if the file was created
    if (fs.existsSync(tempFilePath)) {
      console.log('\nGenerated file content:');
      console.log(fs.readFileSync(tempFilePath, 'utf-8'));
    } else {
      console.log('\nFile was not created.');
    }

    // Generate documentation
    console.log('\nGenerating documentation:');
    const docResult = sendRequest('callTool', {
      name: 'generate_documentation',
      arguments: {
        code: 'function factorial(n) {\n  if (n <= 1) return 1;\n  return n * factorial(n - 1);\n}',
        language: 'JavaScript',
        format: 'JSDoc',
      },
    });
    console.log(JSON.stringify(docResult, null, 2));

    // Ask a question
    console.log('\nAsking a question:');
    const questionResult = sendRequest('callTool', {
      name: 'ask_question',
      arguments: {
        question: 'What is the difference between var, let, and const in JavaScript?',
      },
    });
    console.log(JSON.stringify(questionResult, null, 2));
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Kill the server
    server.kill();
  }
}

main().catch(console.error);
