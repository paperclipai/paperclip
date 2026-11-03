import type { DirectionKit } from "../../kit";
import { LandingBody } from "./LandingBody";
import { CardBody } from "./CardBody";
import { PanelBody } from "./PanelBody";

export const kit: DirectionKit = {
  id: "today",
  name: "0.Today",
  tagline: "What ships now",
  LandingBody,
  CardBody,
  PanelBody,
};
