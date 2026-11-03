import type { DirectionKit } from "../../kit";
import { LandingBody } from "./LandingBody";
import { CardBody } from "./CardBody";
import { PanelBody } from "./PanelBody";
import "./tokens.css";

export const kit: DirectionKit = {
  id: "d1-focus",
  name: "1.Focus",
  tagline: "The familiar list, decluttered — decision first",
  LandingBody,
  CardBody,
  PanelBody,
};
