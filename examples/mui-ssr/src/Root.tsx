import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { Outlet } from "react-router";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { theme } from "./theme";

export function Root() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Header />
      <main>
        <Outlet />
      </main>
      <Footer />
    </ThemeProvider>
  );
}
