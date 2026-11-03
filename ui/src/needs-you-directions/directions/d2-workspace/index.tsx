import type { DirectionKit } from "../../kit";
import { LandingBody } from "./LandingBody";
import { CardBody } from "./CardBody";
import { PanelBody } from "./PanelBody";
import "./tokens.css";

export const kit: DirectionKit = {
  id: "d2-workspace",
  name: "2.Workspace",
  tagline: "Direction 2",
  LandingBody,
  CardBody,
  PanelBody,
};
