import { QueryClientProvider } from "@tanstack/react-query";
import { AppRouter } from "./app-router";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ThemeProvider } from "./components/shared/ThemeProvider";
import { queryClient } from "./features/api/query-client";

export function App() {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AppRouter />
        </QueryClientProvider>
      </ErrorBoundary>
    </ThemeProvider>
  );
}

export default App;
