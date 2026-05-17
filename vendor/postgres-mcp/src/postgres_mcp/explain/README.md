# PostgreSQL Explain Tools

This module provides tools for analyzing PostgreSQL query execution plans.

## Tools

### ExplainPlanTool

Provides methods for generating different types of EXPLAIN plans.

## Usage

The explain tool is integrated into the PostgreSQL MCP server and can be used through the MCP API via the function:

- `explain_query`

This function accepts parameters to control the behavior:
- `sql` - The SQL query to explain (required)
- `analyze` - When true, executes the query to get real statistics (default: false)
- `hypothetical_indexes` - Optional list of indexes to simulate without creating them

## Benefits

- **Query Understanding**: Helps understand how PostgreSQL executes queries
- **Performance Analysis**: Identifies bottlenecks and optimization opportunities
- **Index Testing**: Tests hypothetical indexes without actually creating them
